import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoopRuntime } from '../lib/loop.js'
import { createDshIntegration } from '../lib/dsh-integration.js'
import { createExecutionStore } from '../lib/execution-store.js'
import { Readable } from 'node:stream'

async function request(runtime,path,body={}) {
 const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST'
 return new Promise((resolve,reject)=>{const res={writeHead(status){this.status=status},end(raw){resolve({status:this.status,body:JSON.parse(raw)})}};runtime.handle(req,res,new URL(`http://test${path}`),path).catch(reject)})
}

function fixture(config={}) {
 const root=mkdtempSync(join(tmpdir(),'memory-auto-extract-'))
 const runtime=createLoopRuntime({root,config:{loopWorker:false,loopEmbedEnabled:false,...config}})
 return {runtime,close(){runtime.close();rmSync(root,{recursive:true,force:true})}}
}

test('completed chat capture persists original roles and queues one durable extraction', t=>{
 const f=fixture();t.after(()=>f.close())
 const input={conversation_id:'session-1',turn_id:'user-seq-12',project:'pumping-well',task:'session-1',modelSelection:{provider:'configured',model:'current'},messages:[
  {id:'u1',role:'user',content:'以后检查代码先给结论'},
  {id:'a1',role:'assistant',content:[{type:'reasoning',text:'private reasoning'},{type:'text',text:'好的，我会先给结论'}]},
  {role:'tool',content:'tool secret'},
  {role:'user',source:{kind:'plugin:@dafeiyu/dsh-memory-brain'},content:'injected memory'},
 ]}
 const first=f.runtime.captureChatTurn(input)
 const again=f.runtime.captureChatTurn(input)
 assert.equal(first.status,'queued');assert.equal(again.duplicate,true)
 assert.equal(f.runtime.db.prepare('SELECT COUNT(*) AS n FROM loop_sources').get().n,1)
 assert.deepEqual(f.runtime.db.prepare('SELECT role,content FROM loop_messages ORDER BY ordinal').all().map(r=>[r.role,r.content]),[['user','以后检查代码先给结论'],['assistant','好的，我会先给结论']])
 const jobs=f.runtime.db.prepare('SELECT payload_json FROM loop_jobs').all()
 assert.equal(jobs.length,1);assert.deepEqual(JSON.parse(jobs[0].payload_json).model_selection,input.modelSelection)
 assert.equal(f.runtime.db.prepare('SELECT project FROM loop_sources').get().project,'pumping-well')
})

test('background extraction uses the captured host model and keeps assistant claims as candidates', async t=>{
 const f=fixture({loopWorker:true,loopWorkerIntervalMs:40});t.after(()=>f.close())
 const selections=[]
 f.runtime.setChatExtractionModel(async(messages,selection)=>{
  selections.push(selection)
  assert.ok(messages[0].content.includes('原子记忆'))
  return JSON.stringify({memories:[{type:'preference',text:'回答先给结论',evidence_message_ids:['m1']},{type:'fact',text:'助手声称项目已上线',source_category:'user_statement',evidence_message_ids:['m2']}]})
 })
 const captured=f.runtime.captureChatTurn({conversation_id:'s',turn_id:1,modelSelection:{provider:'p',model:'host-model'},messages:[{role:'user',content:'以后回答先给结论'},{role:'assistant',content:'项目已经上线'}]})
 let job
 for(let i=0;i<200;i++){job=f.runtime.db.prepare('SELECT status,error FROM loop_jobs WHERE id=?').get(captured.job_id);if(['done','failed','partial'].includes(job.status))break;await new Promise(r=>setTimeout(r,10))}
 assert.equal(job.status,'done',job.error)
 assert.deepEqual(selections,[{provider:'p',model:'host-model'}])
 const memories=f.runtime.db.prepare('SELECT text,status FROM loop_memories ORDER BY text').all()
 assert.equal(memories.find(row=>row.text.includes('先给结论')).status,'confirmed')
 assert.equal(memories.find(row=>row.text.includes('助手')).status,'proposed')
 assert.equal(f.runtime.db.prepare('SELECT model FROM loop_extraction_runs').get().model,'host-model')
})

test('queued chat extraction waits for the host model service without spending retry attempts', async t=>{
 const f=fixture({loopWorker:true,loopWorkerIntervalMs:40});t.after(()=>f.close())
 const captured=f.runtime.captureChatTurn({conversation_id:'waiting',turn_id:1,modelSelection:{provider:'p',model:'m'},messages:[{role:'user',content:'记住项目名为测试'}]})
 await new Promise(resolve=>setTimeout(resolve,100))
 const row=f.runtime.db.prepare('SELECT status,attempts FROM loop_jobs WHERE id=?').get(captured.job_id)
 assert.equal(row.status,'queued');assert.equal(row.attempts,0)
})

test('a real completed-turn hook flows through the host model into SQLite and the next context',async t=>{
 const f=fixture({loopWorker:true,loopWorkerIntervalMs:40});t.after(()=>f.close())
 const store=createExecutionStore(f.runtime.db);const requests=[]
 const service={resolveModelInfo:async()=>({context:{contextWindow:64000}}),prepareCall:async config=>({config,stream:options=>{requests.push(options);return (async function*(){yield {type:'text-delta',text:JSON.stringify({memories:[{type:'preference',text:'回答先给结论',scope_type:'personal',evidence_message_ids:['m1']}]})};yield {type:'finish',reason:{kind:'stop'}}})()}})}
 const api=createDshIntegration({runtime:f.runtime,executionStore:store,ctx:{inject:(names,callback)=>{if(names.includes('llm'))callback({llm:service,effect(){}})}}})
 const events=[{seq:0,type:'turn/start',data:{turn:1}},{seq:1,type:'user/message',data:{id:'u1',role:'user',source:{kind:'user'},content:[{type:'text',text:'以后回答先给结论'}]}},{seq:2,type:'assistant/message',data:{turn:1,message:{id:'a1',role:'assistant',content:[{type:'text',text:'好的'}]}}},{seq:3,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}]
 const session={id:'session',eventAt:seq=>events[seq]}
 await api.onSessionEvent(session,events[0])
 await api.onPreStep({agent:{session},turn:1,step:1,messages:[events[1].data],modelSelection:{provider:'configured',model:'current'}},()=>({kind:'enter',messages:[]}))
 await api.onSessionEvent(session,events[3])
 const jobId=store.scope('session').auto_extraction.job_id
 let status
 for(let i=0;i<200;i++){status=f.runtime.db.prepare('SELECT status FROM loop_jobs WHERE id=?').get(jobId)?.status;if(['done','failed','partial'].includes(status))break;await new Promise(resolve=>setTimeout(resolve,10))}
 assert.equal(status,'done');assert.equal(requests.length,1)
 assert.equal(requests[0].model,'current');assert.equal(requests[0].sessionId,undefined)
 assert.ok((await f.runtime.buildContext({task_id:'session'})).sections.preferences.some(memory=>memory.text==='回答先给结论'))
 assert.equal(f.runtime.db.prepare('SELECT COUNT(*) AS n FROM loop_sources').get().n,1)
 await api.onSessionEvent(session,events[3]);await new Promise(resolve=>setTimeout(resolve,30))
 assert.equal(requests.length,1,'duplicate turn-end must not repeat model extraction')
})

test('missing model selection saves the conversation without sending it to a fallback endpoint',t=>{
 const f=fixture();t.after(()=>f.close())
 const result=f.runtime.captureChatTurn({conversation_id:'unknown-model',turn_id:1,messages:[{role:'user',content:'这段话先留在本地'}]})
 assert.equal(result.status,'saved');assert.equal(result.reason,'model_selection_missing')
 assert.equal(f.runtime.db.prepare('SELECT COUNT(*) AS n FROM loop_jobs').get().n,0)
 assert.equal(f.runtime.db.prepare('SELECT COUNT(*) AS n FROM loop_messages').get().n,1)
})

test('a queued chat turn resumes after a runtime restart using its persisted model selection',async t=>{
 const root=mkdtempSync(join(tmpdir(),'memory-auto-restart-'));let runtime
 t.after(()=>{runtime?.close();rmSync(root,{recursive:true,force:true})})
 runtime=createLoopRuntime({root,config:{loopWorker:false,loopEmbedEnabled:false}})
 const input={conversation_id:'resumed',turn_id:'seq:10',modelSelection:{provider:'saved-provider',model:'saved-model'},messages:[{role:'user',content:'以后先给结论'}]}
 const captured=runtime.captureChatTurn(input)
 runtime.close()
 runtime=createLoopRuntime({root,config:{loopWorker:true,loopWorkerIntervalMs:40,loopEmbedEnabled:false}})
 const selected=[];runtime.setChatExtractionModel(async(_,selection)=>{selected.push(selection);return '{"memories":[]}'})
 let status
 for(let i=0;i<200;i++){status=runtime.db.prepare('SELECT status FROM loop_jobs WHERE id=?').get(captured.job_id)?.status;if(status==='done')break;await new Promise(resolve=>setTimeout(resolve,10))}
 assert.equal(status,'done');assert.deepEqual(selected,[input.modelSelection])
 assert.equal(runtime.captureChatTurn(input).duplicate,true)
 assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM loop_jobs').get().n,1)
})

test('batch retries of an automatic chat keep its captured model instead of a REST fallback',async t=>{
 const f=fixture({loopWorker:true,loopWorkerIntervalMs:40});t.after(()=>f.close())
 let attempts=0;f.runtime.setChatExtractionModel(async()=>{attempts++;if(attempts===1)throw new Error('temporary host failure');return '{"memories":[]}'})
 const captured=f.runtime.captureChatTurn({conversation_id:'retry',turn_id:1,modelSelection:{provider:'p',model:'captured-model'},messages:[{role:'user',content:'以后先给结论'}]})
 let job
 for(let i=0;i<200;i++){job=f.runtime.db.prepare('SELECT * FROM loop_jobs WHERE id=?').get(captured.job_id);if(job.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,10))}
 assert.equal(job.status,'failed')
 const batch=JSON.parse(job.result_json).batch_id
 const oldFetch=globalThis.fetch;let restCalls=0;globalThis.fetch=async()=>{restCalls++;throw new Error('unexpected REST fallback')};t.after(()=>{globalThis.fetch=oldFetch})
 const retried=await request(f.runtime,`/batches/${batch}/retry`)
 assert.equal(retried.status,200);assert.equal(attempts,2);assert.equal(restCalls,0)
 assert.equal(f.runtime.db.prepare('SELECT model FROM loop_extraction_runs').get().model,'captured-model')
})

test('archiving an in-flight chat source prevents a late model result from reviving memories',async t=>{
 const f=fixture({loopWorker:true,loopWorkerIntervalMs:40});t.after(()=>f.close())
 let release;f.runtime.setChatExtractionModel(()=>new Promise(resolve=>{release=resolve}))
 const captured=f.runtime.captureChatTurn({conversation_id:'withdraw',turn_id:1,modelSelection:{provider:'p',model:'m'},messages:[{role:'user',content:'以后回答先给结论'}]})
 for(let i=0;i<200&&!release;i++)await new Promise(resolve=>setTimeout(resolve,10))
 assert.equal(typeof release,'function')
 assert.equal((await request(f.runtime,`/imports/${captured.source_id}/archive`)).status,200)
 release('{"memories":[{"type":"preference","text":"回答先给结论","evidence_message_ids":["m1"]}]}')
 for(let i=0;i<200;i++){const status=f.runtime.db.prepare('SELECT status FROM loop_jobs WHERE id=?').get(captured.job_id).status;if(['failed','cancelled','done'].includes(status))break;await new Promise(resolve=>setTimeout(resolve,10))}
 assert.equal(f.runtime.db.prepare('SELECT COUNT(*) AS n FROM loop_memories').get().n,0)
 assert.equal(f.runtime.db.prepare('SELECT extraction_status FROM loop_sources WHERE id=?').get(captured.source_id).extraction_status,'archived')
 assert.equal((await f.runtime.buildContext({})).sections.preferences.length,0)
})
