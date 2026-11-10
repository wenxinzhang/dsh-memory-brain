import test from 'node:test'
import assert from 'node:assert/strict'
import { createDshIntegration } from '../lib/dsh-integration.js'
import { estimateTokens } from '../lib/context-compiler.js'

const fixture = (runtime = {}) => {
 const handlers = new Map(); const records = []
 const store = {start:r=>records.push(r),finish:(id,r)=>records.push({id,...r}),tool:r=>records.push(r),scope:()=>({})}
 createDshIntegration({ctx:{on:(name,fn)=>handlers.set(name,fn)},runtime,executionStore:store})
 return {handlers,records}
}

test('a completed host turn queues only that turn visible messages with the captured model', async()=>{
 const captured=[];let scope={project_id:'p1',task_id:'task1'}
 const runtime={captureChatTurn:input=>{captured.push(input);return {status:'queued',job_id:'job1',source_id:'source1'}}}
 const api=createDshIntegration({runtime,executionStore:{scope:(_,patch)=>{if(patch)scope={...scope,...patch};return scope}}})
 const events=[{seq:0,type:'user/message',data:{id:'old',role:'user',content:'previous turn'}},{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{id:'memory',role:'user',source:{kind:'plugin:@dafeiyu/dsh-memory-brain'},content:'injected context'}},{seq:3,type:'user/message',data:{id:'u',role:'user',source:{kind:'user'},content:[{type:'text',text:'以后先给结论'}]}},{seq:4,type:'assistant/message',data:{turn:1,message:{id:'a',role:'assistant',content:[{type:'reasoning',text:'private reasoning'},{type:'text',text:'明白'}]}}},{seq:5,type:'tool/result',data:{text:'tool output'}},{seq:6,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}]
 const session={id:'s',header:{cwd:'E:/p1'},eventAt:seq=>events[seq]}
 await api.onSessionEvent(session,events[1])
 await api.onPreStep({agent:{session},turn:1,step:1,modelSelection:{provider:'p',model:'m'},messages:[events[3].data]},()=>({kind:'enter',messages:[]}))
 scope={...scope,project_id:'next-project'}
 await api.onSessionEvent(session,events[6])
 assert.equal(captured.length,1)
 assert.deepEqual(captured[0].messages.map(message=>[message.role,message.content]),[['user','以后先给结论'],['assistant','明白']])
 assert.deepEqual(captured[0].modelSelection,{provider:'p',model:'m'})
 assert.equal(captured[0].project,'p1');assert.equal(scope.auto_extraction.job_id,'job1')
})

test('automatic extraction calls the declared host model without creating another conversation turn', async()=>{
 let extractor;let preparedConfig;let request;let disposed
 const service={prepareCall:async(config,signal)=>{preparedConfig=config;assert.ok(signal);return {config,stream:options=>{request=options;return (async function*(){yield {type:'reasoning-delta',text:'hidden'};yield {type:'text-delta',text:'partial'};yield {type:'block-end',block:{type:'text',text:'{"memories":[]}'}};yield {type:'finish',reason:{kind:'stop'}}})()}}}}
 createDshIntegration({ctx:{inject:(names,callback)=>{if(names.includes('llm'))callback({llm:service,effect:fn=>{disposed=fn()}})}},runtime:{setChatExtractionModel:fn=>{extractor=fn;return ()=>{extractor=null}}}})
 assert.equal(typeof extractor,'function')
 const answer=await extractor([{role:'system',content:'extract'},{role:'user',content:'visible text'}],{provider:'p',model:'m'},{signal:AbortSignal.timeout(1000)})
 assert.equal(answer,'{"memories":[]}');assert.equal(preparedConfig.provider,'p');assert.equal(preparedConfig.model,'m')
 assert.equal(request.sessionId,undefined);assert.equal(request.tools,undefined)
 assert.equal(request.messages[1].content[0].text,'visible text');assert.ok(request.messages[1].id)
 disposed();assert.equal(extractor,null)
})

test('failed cancelled preview-blocked and disabled turns never trigger automatic extraction',async()=>{
 for(const scenario of [{kind:'error'},{kind:'aborted'},{kind:'blocked'},{kind:'max-tokens'},{kind:'completed',scope:{auto_extract:false}},{kind:'completed',scope:{mode:'off'}},{kind:'completed',scope:{ignored_by_turn:{1:true}}},{kind:'completed',config:{loopAutoExtract:false}}]) {
  let captures=0
  const events=[{seq:0,type:'turn/start',data:{turn:1}},{seq:1,type:'user/message',data:{role:'user',source:{kind:'user'},content:'不要把失败当成功'}},{seq:2,type:'turn/end',data:{turn:1,reason:{kind:scenario.kind}}}]
  const session={id:'s',eventAt:seq=>events[seq]}
  const api=createDshIntegration({config:scenario.config,runtime:{captureChatTurn(){captures++}},executionStore:{scope:()=>scenario.scope || {}}})
  await api.onSessionEvent(session,events[0]);await api.onSessionEvent(session,events[2])
  assert.equal(captures,0,JSON.stringify(scenario))
 }
})
test('workspace and current question automatically bind the persisted conversation scope', async () => {
 let scope={mode:'auto'};const inputs=[];const inferred=[]
 const api=createDshIntegration({runtime:{inferConversationScope:input=>{inferred.push(input);return {project_id:'pumping-well',project_name:'pumping-well',workspace:input.cwd,object_id:input.query.includes('WELL_001')?'well-1':null,object_name:input.query.includes('WELL_001')?'WELL_001':null}},buildContext:input=>{inputs.push(input);return {ok:true,sections:{}}}},executionStore:{scope:(_,patch)=>{if(patch)scope={...scope,...patch};return scope}}})
 const agent={session:{id:'session-1',header:{cwd:'E:\\projects\\pumping-well'}}}
 const run=async(query,turn)=>{const messages=[{role:'user',content:query}];return api.onPreStep({agent,messages,turn,step:1},()=>({kind:'enter',messages}))}
 await run('检查 WELL_001',1)
 assert.equal(inferred[0]?.cwd,'E:\\projects\\pumping-well')
 assert.equal(scope.project_id,'pumping-well');assert.equal(scope.task_id,'session-1');assert.equal(scope.task_description,'检查 WELL_001')
 assert.equal(inputs[0].object_id,'well-1')
 await run('检查项目整体',2)
 assert.equal(scope.object_id,null);assert.equal(scope.task_description,'检查项目整体')
 scope={...scope,project_id:'manual-project',task_description:'用户明确绑定的任务'}
 await run('下一步',3)
 assert.equal(inputs.at(-1).project,'manual-project');assert.equal(inputs.at(-1).task,'用户明确绑定的任务')
})
test('model metadata and token meter are read only through declared Cordis injections', async () => {
 let queried=false;const disposers=[];const declared=[]
 const ctx={
  get llm(){throw new Error('cannot get property "llm" without inject')},
  get tokenMeter(){throw new Error('cannot get property "tokenMeter" without inject')},
  inject(deps,callback){
   declared.push(deps.join(','))
   if(deps.includes('llm')) callback({llm:{resolveModelInfo:async()=>{queried=true;return {context:{contextWindow:64000}}}},effect(fn){disposers.push(fn())}})
   else callback({tokenMeter:{estimateMessage:()=>1},effect(fn){disposers.push(fn())}})
  },
  on(){},
 }
 const api=createDshIntegration({ctx,runtime:{buildContext:()=>({ok:true,sections:{}})},executionStore:{scope:()=>({})}})
 const messages=[{role:'user',content:'question'}]
 const result=await api.onPreStep({agent:{session:{id:'s'}},modelSelection:{provider:'p',model:'m'},messages},()=>({kind:'enter',messages}))
 assert.equal(result.kind,'enter');assert.equal(queried,true)
 assert.deepEqual(declared,['llm','tokenMeter'])
 disposers.forEach(dispose=>dispose())
 queried=false
 await api.onPreStep({agent:{session:{id:'s'}},modelSelection:{provider:'p',model:'m'},messages},()=>({kind:'enter',messages}))
 assert.equal(queried,false,'disposed services must not remain captured')
})
test('independent usage chunks survive a finish chunk without usage', async () => {
 const {handlers,records}=fixture()
 const usage={inputTokens:120,outputTokens:30}
 await Array.fromAsync(handlers.get('llm/stream')({sessionId:'s',messages:[]},()=> (async function*(){yield {type:'usage',usage};yield {type:'finish',reason:{kind:'stop'}}})()))
 assert.deepEqual(records.at(-1).usage,usage)
})
test('first-step budget uses the selected model metadata rather than a stale session window', async () => {
 let selection
 const api=createDshIntegration({ctx:{inject:(_,fn)=>fn({llm:{resolveModelInfo:async(provider,model)=>{selection={provider,model};return {context:{contextWindow:64000},defaultMaxTokens:1000}}}})},runtime:{buildContext:()=>({ok:true,sections:{}})},executionStore:{scope:()=>({})}})
 const messages=[{role:'user',content:'x'.repeat(9000)}]
 const result=await api.onPreStep({agent:{session:{id:'s',requestContext:()=>({contextWindow:8192})}},modelSelection:{provider:'p',model:'large'},messages},()=>({kind:'enter',messages}))
 assert.equal(result.kind,'enter')
 assert.deepEqual(selection,{provider:'p',model:'large'})
})
test('a delayed request cannot claim the context prepared for a different turn', async () => {
 let sent=0
 const api=createDshIntegration({runtime:{buildContext:()=>({ok:true,sections:{}})},executionStore:{scope:()=>({}),start(){},finish(){},sent(){sent++}}})
 const agent={session:{id:'s'}};const messages=[{role:'user',content:'query'}]
 const first=await api.onPreStep({agent,turn:1,step:1,messages},()=>({kind:'enter',messages}))
 const signal=new AbortController().signal
 api.onAgentRequest({agent,turn:1,step:1,signal},()=>({}))
 await api.onPreStep({agent,turn:2,step:1,messages},()=>({kind:'enter',messages}))
 await Array.fromAsync(api.onStream({sessionId:'s',signal,messages:first.messages},()=> (async function*(){})()))
 assert.equal(sent,0)
})
test('pre-step injects structured message without mutating frozen source', async()=>{
 const {handlers}=fixture({buildContext:async()=>({ok:true,run_id:'r',sections:{facts:[{id:'f',text:'reference'}]}})})
 const source=Object.freeze([{role:'user',content:[{type:'text',text:'hello'}]}]); const decision=Object.freeze({kind:'continue',messages:source})
 const result=await handlers.get('agent/pre-step')({agent:{session:{id:'s'}},messages:source},()=>decision)
 assert.equal(source.length,1); assert.equal(result.messages.length,2)
 assert.equal(result.messages[1].content[0].type,'text')
})
test('stream is synchronous AsyncIterable and next ignores replacement args',async()=>{
 const {handlers,records}=fixture(); const options=Object.freeze({sessionId:'s',messages:Object.freeze([])})
 const chunks=[{type:'text',text:'answer'}]; const stream=handlers.get('llm/stream')(options,()=> (async function*(){yield* chunks})())
 assert.equal(typeof stream[Symbol.asyncIterator],'function')
 assert.deepEqual(await Array.fromAsync(stream),chunks)
 assert.equal(records.at(-1).status,'completed')
})
test('deny and ask stop next while recording real arguments',async()=>{
 for(const outcome of ['blocked','pending_authorization']){
  let input; const {handlers}=fixture({checkAction:async value=>{input=value;return {result:outcome}}});let called=false
  const out=await handlers.get('tools/pre-execute')({name:'write',arguments:{path:'x'},callId:'c',agent:{session:{id:'s'}}},()=>{called=true;return {kind:'allow'}})
  assert.equal(called,outcome==='pending_authorization');assert.equal(out.kind,outcome==='blocked'?'deny':'ask');assert.deepEqual(input.action.parameters,{path:'x'})
 }
})
test('post execute records result and preserves waterfall disposition',async()=>{
 const {handlers,records}=fixture();const result={ok:true};const out=await handlers.get('tools/post-execute')({name:'read',callId:'c'},result,()=>({kind:'accept'}))
 assert.equal(out.kind,'accept');assert.equal(records[0].result,result)
})
test('stream records provider failure and propagates it',async()=>{
 const {handlers,records}=fixture();const error=new Error('provider down')
 const stream=handlers.get('llm/stream')(Object.freeze({sessionId:'s',messages:[]}),()=> (async function*(){throw error})())
 await assert.rejects(()=>Array.fromAsync(stream),error)
 assert.equal(records.at(-1).status,'failed')
})
test('early stream return records cancellation',async()=>{
 const {handlers,records}=fixture()
 const stream=handlers.get('llm/stream')({sessionId:'s',messages:[]},()=> (async function*(){yield {text:'a'};yield {text:'b'}})())
 await stream.next();await stream.return()
 assert.equal(records.at(-1).status,'cancelled')
})
test('agent request only associates and does not transform request',async()=>{
 const {handlers}=fixture();const payload=Object.freeze({turn:1,step:2,signal:new AbortController().signal});let called=false
 const out=handlers.get('agent/request')(payload,()=>{called=true;return 'sent'})
 assert.equal(out,'sent');assert.equal(called,true)
})

test('pre-step messages satisfy the installed dsh source contract', async()=>{
 const {handlers}=fixture({buildContext:async()=>({ok:true,run_id:'r',sections:{facts:[{id:'f',text:'reference'}]}})})
 const source=Object.freeze([{id:'user-1',role:'user',source:{kind:'user'},content:[{type:'text',text:'hello'}]}])
 const decision=Object.freeze({kind:'enter',messages:source})
 const result=await handlers.get('agent/pre-step')({agent:{session:{id:'s'}},messages:source},()=>decision)
 // The installed agent-loop reads source.kind before persisting any message.
 assert.doesNotThrow(()=>result.messages.forEach(message=>message.source.kind))
 const injected=result.messages.at(-1)
 assert.equal(injected.source.kind,'plugin:@dafeiyu/dsh-memory-brain')
 assert.equal(typeof injected.id,'string')
 assert.ok(injected.id.length>0)
 assert.equal(result.kind,'enter')
})

test('failed mandatory checks never dispatch the tool', async () => {
 const {handlers}=fixture({checkAction:async()=>({ok:false,error:'hard_constraints_exceed_budget'})})
 let called=false
 const result=await handlers.get('tools/pre-execute')({name:'delete',callId:'c',agent:{session:{id:'s'}}},()=>{called=true;return {kind:'allow'}})
 assert.equal(called,false)
 assert.equal(result.kind,'deny')
})

test('stream finish errors stay failed and reasoning is not saved as an answer', async () => {
 const {handlers,records}=fixture()
 const chunks=[{type:'reasoning-delta',text:'private reasoning'},{type:'text-delta',text:'visible answer'},{type:'finish',reason:{kind:'error',failure:{code:'NETWORK_ERROR',message:'down'}}}]
 await Array.fromAsync(handlers.get('llm/stream')({sessionId:'s',messages:[]},()=> (async function*(){yield* chunks})()))
 assert.equal(records.at(-1).status,'failed')
 assert.equal(records.at(-1).answer,'visible answer')
 assert.equal(typeof records[0].attempt,'number')
})

test('ordinary subsequent messages are not automatically user feedback', async () => {
 let feedback=0
 const api=createDshIntegration({runtime:{},executionStore:{scope:()=>({}),start(){},finish(){},feedback(){feedback++}}})
 await Array.fromAsync(api.onStream({sessionId:'s',messages:[]},()=> (async function*(){yield {type:'text-delta',text:'answer'}})()))
 await api.onSessionEvent({id:'s'},{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'next question'}]}})
 assert.equal(feedback,0)
})

test('preview rejects the model step until its exact context is approved', async () => {
 let scope={mode:'preview'}
 const api=createDshIntegration({runtime:{buildContext:async()=>({ok:true,run_id:'r',sections:{facts:[{id:'f',text:'fact'}]}})},executionStore:{scope:(_,patch)=>{if(patch)scope={...scope,...patch};return scope}}})
 const payload={agent:{session:{id:'s'}},turn:1,step:1,messages:[{role:'user',content:'question'}]}
 const decision=()=>({kind:'enter',messages:payload.messages})
 assert.equal((await api.onPreStep(payload,decision)).kind,'reject')
 assert.ok(scope.preview?.fingerprint)
 scope.preview_approval=scope.preview.fingerprint
 assert.equal((await api.onPreStep(payload,decision)).kind,'enter')
 assert.equal(scope.preview_approval,null)
})

test('preview approval cannot be reused for a different question with identical facts', async () => {
 let scope={mode:'preview'}
 const api=createDshIntegration({runtime:{buildContext:async()=>({ok:true,sections:{}})},executionStore:{scope:(_,patch)=>{if(patch)scope={...scope,...patch};return scope}}})
 const payload={agent:{session:{id:'s'}},turn:1,step:1,messages:[{role:'user',content:'question one'}]}
 await api.onPreStep(payload,()=>({kind:'enter',messages:payload.messages}))
 scope.preview_approval=scope.preview.fingerprint
 const next=await api.onPreStep({...payload,turn:2,messages:[{role:'user',content:'different question'}]},()=>({kind:'enter',messages:[]}))
 assert.equal(next.kind,'reject')
})

test('durable session projections retain one current memory block and clear it when off', async () => {
 const events=[];const nodes=[]
 const session={id:'s',events,surface:{nodes},append(type,data,opts={surfaceOp:'append'}) {
  const event={seq:events.length,type,data:structuredClone(data),...opts};events.push(event)
  if(typeof opts.surfaceOp==='object'){assert.deepEqual(opts.sourceEventSeqs,[opts.surfaceOp.start]);nodes.splice(nodes.indexOf(opts.surfaceOp.start),1,event.seq)}else nodes.push(event.seq)
 },deriveMessages(){return nodes.map(seq=>events[seq].data)}}
 let mode='auto';let text='one'
 const api=createDshIntegration({runtime:{buildContext:async()=>({ok:true,sections:{facts:[{id:'f',text}]}})},executionStore:{scope:()=>({mode})}})
 for(let turn=1;turn<=3;turn++){
  text=String(turn)
  const messages=[{role:'user',content:[{type:'text',text:'question'}]}]
  const decision=await api.onPreStep({agent:{session},turn,step:1,messages},()=>({kind:'enter',messages}))
  decision.messages.forEach(message=>session.append('user/message',message,{surfaceOp:'append'}))
 }
 assert.equal(session.deriveMessages().filter(m=>JSON.stringify(m).includes('MEMORY_BRAIN_CONTEXT_BEGIN')).length,1)
 mode='off'
 await api.onPreStep({agent:{session},turn:4,step:1,messages:[]},()=>({kind:'enter',messages:[]}))
 assert.equal(session.deriveMessages().filter(m=>JSON.stringify(m).includes('MEMORY_BRAIN_CONTEXT_BEGIN')).length,0)
 assert.equal(events.filter(e=>JSON.stringify(e.data).includes('MEMORY_BRAIN_CONTEXT_BEGIN')).length,3)
})

test('desktop 0.2.2 eventAt and startSeq surface contracts replace rather than append', async () => {
 const log=[];const nodes=[]
 const session={id:'desktop',surface:{nodes},eventAt:seq=>log[seq],append(type,data,options={surfaceOp:'append'}){
  const event={seq:log.length,type,data:structuredClone(data),...options};log.push(event)
  if(typeof options.surfaceOp==='object'){
   assert.deepEqual(Object.keys(options.surfaceOp).sort(),['endSeq','op','startSeq'])
   assert.deepEqual(options.sourceEventSeqs,[options.surfaceOp.startSeq])
   nodes.splice(nodes.indexOf(options.surfaceOp.startSeq),1,event.seq)
  }else nodes.push(event.seq)
 }}
 let mode='auto';const api=createDshIntegration({runtime:{buildContext:async()=>({ok:true,sections:{}})},executionStore:{scope:()=>({mode})}})
 for(let turn=1;turn<=2;turn++){
  const messages=[{role:'user',content:'question'}]
  const result=await api.onPreStep({agent:{session},messages,turn,step:1},()=>({kind:'enter',messages}))
  result.messages.forEach(m=>session.append('user/message',m))
 }
 const visible=()=>nodes.map(seq=>log[seq].data).filter(m=>JSON.stringify(m).includes('MEMORY_BRAIN_CONTEXT_BEGIN'))
 assert.equal(visible().length,1)
 mode='off';await api.onPreStep({agent:{session},messages:[],turn:3,step:1},()=>({kind:'enter',messages:[]}))
 assert.equal(visible().length,0)
})

test('internal tool steps retain the original task query', async () => {
 const queries=[]
 const api=createDshIntegration({runtime:{buildContext:async input=>{queries.push(input.query);return {ok:true,sections:{}}}},executionStore:{scope:()=>({})}})
 const payload={agent:{session:{id:'s'}},turn:1,step:1,messages:[{role:'user',content:'prepare a report'}]}
 await api.onPreStep(payload,()=>({kind:'enter',messages:payload.messages}))
 await api.onPreStep({...payload,step:2,messages:[]},()=>({kind:'enter',messages:[]}))
 assert.deepEqual(queries,['prepare a report','prepare a report'])
})

test('the actual request budget includes history and prevents provider dispatch', async () => {
 let sent=false;const records=[]
 const api=createDshIntegration({config:{contextWindow:1000,reservedOutput:100},executionStore:{start:r=>records.push(r),finish:(_,r)=>records.push(r)}})
 const stream=api.onStream({sessionId:'s',messages:[{role:'user',content:'x'.repeat(5000)}]},()=>{sent=true;return (async function*(){})()})
 await assert.rejects(()=>Array.fromAsync(stream),/request_exceeds_model_budget/)
 assert.equal(sent,false)
 assert.equal(records.at(-1).status,'failed')
})

test('a large real-world transcript inside the model window is not rejected', async () => {
 const records=[];let sent=false
 const session={id:'s',requestContext:()=>({contextWindow:1048576})}
 const api=createDshIntegration({config:{reservedOutput:2048},runtime:{buildContext:()=>({ok:true,sections:{}})},executionStore:{scope:()=>({}),start:r=>records.push(r),finish:(_,r)=>records.push(r)}})
 const question=[{role:'user',content:'question'}]
 await api.onPreStep({agent:{session},turn:1,step:1,messages:question},()=>({kind:'enter',messages:question}))
 // One 900 KiB history block used to be priced per UTF-8 byte (~900k tokens) and
 // aborted the turn; the host-density heuristic prices it under the 1M window.
 const history=[{role:'user',content:'x'.repeat(900*1024)}]
 assert.ok(estimateTokens({messages:history}) < 300000)
 const stream=api.onStream({sessionId:'s',maxTokens:256000,messages:history},()=>{sent=true;return (async function*(){yield {type:'text',text:'ok'};yield {type:'finish',reason:{kind:'stop'}}})()})
 await Array.fromAsync(stream)
 assert.equal(sent,true)
 assert.equal(records.at(-1).status,'completed')
})

test('an oversized maxTokens cannot reject a request that fits the window', async () => {
 let sent=false
 const session={id:'s',requestContext:()=>({contextWindow:262144})}
 const api=createDshIntegration({runtime:{buildContext:()=>({ok:true,sections:{}})},executionStore:{scope:()=>({}),start(){},finish(){}}})
 await api.onPreStep({agent:{session},turn:1,step:1,messages:[{role:'user',content:'q'}]},()=>({kind:'enter',messages:[]}))
 const stream=api.onStream({sessionId:'s',maxTokens:262144,messages:[{role:'user',content:'hello'}]},()=>{sent=true;return (async function*(){})()})
 await Array.fromAsync(stream)
 assert.equal(sent,true)
})

test('an unknown model window skips the request budget guard instead of guessing', async () => {
 let sent=false;const warnings=[]
 const api=createDshIntegration({config:{reservedOutput:2048},logger:{warn:message=>warnings.push(message)},executionStore:{scope:()=>({}),start(){},finish(){}}})
 const stream=api.onStream({sessionId:'s',maxTokens:256000,messages:[{role:'user',content:'x'.repeat(900*1024)}]},()=>{sent=true;return (async function*(){})()})
 await Array.fromAsync(stream)
 assert.equal(sent,true)
 assert.ok(warnings.some(line=>line.includes('request budget guard skipped')))
})
