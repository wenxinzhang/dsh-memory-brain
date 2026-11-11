import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createLoopRuntime, parseJsonConversation } from '../lib/loop.js'
import { createDshIntegration } from '../lib/dsh-integration.js'
import { createExecutionStore } from '../lib/execution-store.js'

function fixture(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-audit-regression-'))
  const rt = createLoopRuntime({ root, config: { loopDb: join(root, 'test.db'), loopWorker: false, loopEmbedEnabled: false, ...config } })
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method
    return new Promise((resolve, reject) => {
      const res = { writeHead(status) { this.status = status }, end(value) { resolve({ status: this.status, body: JSON.parse(value) }) } }
      rt.handle(req, res, new URL(`http://test${path}`), path.split('?')[0]).catch(reject)
    })
  }
  return { rt, request, close() { rt.close(); rmSync(root, { recursive: true, force: true }) } }
}

async function extract(f, messages, options = {}) {
  const imported = await f.request('/import', { text: JSON.stringify({ messages }), format: 'json', autoExtract: true, ...options })
  assert.equal(imported.status, 200)
  for (let i = 0; i < 400; i++) {
    const result = await f.request(`/jobs/${imported.body.job_id}`)
    if (['done', 'partial', 'failed', 'cancelled'].includes(result.body.job.status)) {
      assert.equal(result.body.job.status, 'done', result.body.job.error)
      return imported.body.source.id
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('extraction timeout')
}

function insertRule(f, overrides = {}) {
  const r = { id: 'rule-1', name: '检修禁删除', category: 'business_constraint', source_category: 'user_statement', scope_type: 'personal', owner: 'local-user', governance_status: 'active', strength: 'must_not', conditions_json: JSON.stringify({ op: 'eq', path: 'well.status', value: 'maintenance' }), actions_json: '[{"type":"block","target":"delete"}]', structure_status: 'structured', confirmation: 'confirmed', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...overrides }
  f.rt.db.prepare(`INSERT INTO loop_rules(${Object.keys(r).join(',')}) VALUES(${Object.keys(r).map(() => '?').join(',')})`).run(...Object.values(r))
  return r.id
}

test('context evidence preserves the actual imported source title and message identity', async t => {
 const f=fixture({loopWorker:true,loopWorkerIntervalMs:40});const originalFetch=globalThis.fetch
 globalThis.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({memories:[{type:'fact',text:'WELL_001 正在检修',evidence_message_ids:['m1']}]})}}]})})
 t.after(()=>{globalThis.fetch=originalFetch;f.close()})
 await extract(f,[{role:'user',content:'WELL_001 正在检修'}],{title:'现场记录'})
 const context=await f.rt.buildContext({query:'WELL_001'})
 assert.equal(context.sections.facts[0]?.evidence[0]?.source_title,'现场记录')
 assert.ok(context.sections.facts[0]?.evidence[0]?.source_id)
 assert.ok(context.sections.facts[0]?.evidence[0]?.message_id)
})

test('conversation scope matches workspace project and only an unambiguous mentioned object', t => {
 const f=fixture();t.after(()=>f.close())
 const stamp=new Date().toISOString()
 const insert=f.rt.db.prepare('INSERT INTO loop_ontology_instances(id,type_id,name,owner,project,status,candidate,created_at,updated_at) VALUES(?,?,?,?,?,\'active\',0,?,?)')
 insert.run('well-a','well','WELL_001','local-user','pumping-well',stamp,stamp)
 insert.run('well-b','well','WELL_002','local-user','pumping-well',stamp,stamp)
 insert.run('foreign','well','WELL_001','other-user','pumping-well',stamp,stamp)
 const result=f.rt.inferConversationScope({cwd:'E:\\projects\\pumping-well',query:'检查 WELL_001 的状态'})
 assert.equal(result.project_id,'pumping-well');assert.equal(result.project_name,'pumping-well')
 assert.equal(result.object_id,'well-a')
 assert.equal(f.rt.inferConversationScope({cwd:'E:\\projects\\pumping-well',query:'比较 WELL_001 和 WELL_002'}).object_id,null)
 assert.equal(f.rt.inferConversationScope({query:'检查 WELL_001'}).project_id,null)
 assert.equal(f.rt.inferConversationScope({query:'检查 WELL_001'}).object_id,null)
})
test('automatic project matching recognizes project-scoped rules without a project column', t => {
 const f=fixture();t.after(()=>f.close())
 insertRule(f,{scope_type:'project',scope_id:'pumping-well'})
 assert.equal(f.rt.inferConversationScope({cwd:'E:\\projects\\pumping-well'}).project_id,'pumping-well')
})

test('automatic workspace scope reaches the real SQLite context loader and survives restart', async t => {
 const f=fixture();t.after(()=>f.close())
 const stamp=new Date().toISOString()
 f.rt.db.prepare("INSERT INTO loop_ontology_instances(id,type_id,name,owner,project,status,candidate,created_at,updated_at) VALUES('scope-well','well','WELL_001','local-user','pumping-well','active',0,?,?)").run(stamp,stamp)
 const store=createExecutionStore(f.rt.db)
 const api=createDshIntegration({runtime:f.rt,executionStore:store})
 const messages=[{role:'user',content:'检查 WELL_001 的状态'}]
 const result=await api.onPreStep({agent:{session:{id:'auto-session',header:{cwd:'E:\\projects\\pumping-well'}}},messages,turn:1,step:1},()=>({kind:'enter',messages}))
 const scope=createExecutionStore(f.rt.db).scope('auto-session')
 assert.equal(scope.project_id,'pumping-well');assert.equal(scope.object_id,'scope-well')
 assert.equal(scope.auto_scope.project_id,'pumping-well')
 const payload=JSON.parse(result.messages.at(-1).content[0].text.split('\n')[1])
 assert.ok(payload.untrusted_reference_data.some(row=>row.category==='objects' && row.id==='scope-well'))
})

test('rule evaluation reads the selected object current state from the database', async t => {
  const f = fixture(); t.after(() => f.close()); insertRule(f)
  const stamp = new Date().toISOString()
  f.rt.db.prepare("INSERT INTO loop_ontology_instances(id,type_id,name,owner,status,candidate,created_at,updated_at) VALUES('well-1','well','WELL_001','local-user','active',0,?,?)").run(stamp, stamp)
  f.rt.db.prepare("INSERT INTO loop_state_history(id,instance_id,state,reason,created_at) VALUES('state-1','well-1','maintenance','manual',?)").run(stamp)
  const context = await f.rt.buildContext({ object_id: 'well-1' })
  assert.equal(context.sections.rules[0]?.id, 'rule-1')
})

test('an unknown mandatory rule prevents the affected action', async t => {
  const f = fixture(); t.after(() => f.close()); insertRule(f)
  const result = await f.rt.checkAction({ action: { type: 'delete', target: 'delete' } })
  assert.equal(result.result, 'pending_authorization')
  assert.equal(result.executed, false)
  const unrelated = await f.rt.checkAction({ action: { type: 'read', target: 'read' } })
  assert.equal(unrelated.result, 'no_applicable_action')
})

test('the host action gate checks the actual tool rather than unrelated rules', async t => {
  const f = fixture(); t.after(() => f.close()); insertRule(f, { conditions_json: '{"op":"eq","path":"owner","value":"local-user"}' })
  const api = createDshIntegration({ runtime: f.rt, executionStore: { scope: () => ({}), tool() {} } })
  const exec = name => ({ name, callId: name, arguments: { path: 'synthetic' }, agent: { session: { id: 'test' } } })
  assert.equal((await api.onPreExecute(exec('read'), () => ({ kind: 'allow' }))).kind, 'allow')
  assert.equal((await api.onPreExecute(exec('delete'), () => ({ kind: 'allow' }))).kind, 'deny')
})

test('a policy allow is not forged into explicit user authorization', async t => {
  const f=fixture();t.after(()=>f.close())
  insertRule(f,{strength:'must',category:'workflow',conditions_json:'{"op":"eq","path":"owner","value":"local-user"}',actions_json:'[{"type":"execute","target":"write"}]'})
  insertRule(f,{id:'permission',strength:'must',category:'permission',conditions_json:'{"op":"eq","path":"owner","value":"local-user"}',actions_json:'[{"type":"allow","target":"write"}]'})
  const authorizations=[]
  const api=createDshIntegration({runtime:{...f.rt,checkAction:(input,trusted)=>{authorizations.push(trusted);return f.rt.checkAction(input,trusted)}},executionStore:{scope:()=>({}),tool(){}}})
  const exec={name:'write',callId:'test',arguments:{authorized:true},agent:{session:{id:'s'}}}
  assert.equal((await api.onPreExecute(exec,()=>({kind:'allow'}))).kind,'ask')
  assert.ok(authorizations.every(value=>value?.authorized!==true))
  assert.equal((await api.onPreExecute(exec,()=>({kind:'deny',reason:'host policy'}))).kind,'deny')
})

test('host approval cannot compensate for a missing business permission rule', async t => {
  const f=fixture();t.after(()=>f.close())
  insertRule(f,{strength:'must',category:'workflow',conditions_json:'{"op":"eq","path":"owner","value":"local-user"}',actions_json:'[{"type":"execute","target":"write"}]'})
  const api=createDshIntegration({runtime:f.rt,executionStore:{scope:()=>({}),tool(){}}})
  const result=await api.onPreExecute({name:'write',callId:'c',agent:{session:{id:'s'}},arguments:{}},()=>({kind:'allow'}))
  assert.equal(result.kind,'deny')
})

test('rule exceptions and event boundaries exclude inapplicable constraints', async t => {
  const f = fixture(); t.after(() => f.close())
  insertRule(f, { trigger_event: 'delete', exceptions_json: JSON.stringify([{ op: 'eq', path: 'state.emergency', value: true }]) })
  const excepted = await f.rt.buildContext({ event: 'delete', well: { status: 'maintenance' }, state: { emergency: true } })
  assert.equal(excepted.sections.rules.length, 0)
  const wrongEvent = await f.rt.buildContext({ event: 'read', well: { status: 'maintenance' } })
  assert.equal(wrongEvent.sections.rules.length, 0)
})

test('a candidate replacement keeps the approved rule active until approval', async t => {
  const f = fixture(); t.after(() => f.close()); insertRule(f)
  const result = await f.request('/rules/rule-1/supersede', { description: '修订候选' })
  assert.equal(result.status, 200)
  assert.equal(result.body.rule.governance_status, 'candidate')
  assert.equal(f.rt.db.prepare("SELECT governance_status FROM loop_rules WHERE id='rule-1'").get().governance_status, 'active')
  await f.request(`/rules/${result.body.rule.id}/approve`, {})
  assert.equal(f.rt.db.prepare("SELECT governance_status FROM loop_rules WHERE id='rule-1'").get().governance_status, 'superseded')
})

test('an unbound task does not load project-bound personal memories', async t => {
  const f = fixture({ loopWorker: true, loopWorkerIntervalMs: 40 }); const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ memories: [{ type: 'preference', text: '项目偏好', scope_type: 'personal', evidence_message_ids: ['m1'] }] }) } }] }) })
  t.after(() => { globalThis.fetch = originalFetch; f.close() })
  await extract(f, [{ role: 'user', content: '项目偏好' }], { project: 'private-project' })
  assert.equal((await f.rt.buildContext({})).sections.preferences.length, 0)
  assert.equal((await f.rt.buildContext({ project: 'private-project' })).sections.preferences.length, 1)
})

test('a worker that loses its lease cannot publish a late extraction result', async t => {
  const f=fixture({loopWorker:true,loopWorkerIntervalMs:40});const originalFetch=globalThis.fetch;const pending=[];let second
  globalThis.fetch=async()=>new Promise(resolve=>pending.push(()=>resolve({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({rules:[{name:'检修约束',category:'business_constraint',scope_type:'personal',strength:'must_not',conditions:{op:'eq',path:'well.status',value:'maintenance'},actions:[{type:'block',target:'delete'}],evidence_message_ids:['m1']}]})}}]})})))
  const wait=async predicate=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10))}throw new Error('worker timeout')}
  t.after(()=>{globalThis.fetch=originalFetch;second?.close();f.close()})
  const imported=await f.request('/import',{text:'用户：检修时禁止删除',autoExtract:true})
  await wait(()=>pending.length===1)
  f.rt.db.prepare("UPDATE loop_jobs SET lease_until='2000-01-01' WHERE id=?").run(imported.body.job_id)
  second=createLoopRuntime({root:tmpdir(),config:{loopDb:f.rt.dbPath,loopWorker:true,loopWorkerIntervalMs:40,loopEmbedEnabled:false}})
  await wait(()=>pending.length===2)
  pending[1]();await wait(()=>f.rt.db.prepare('SELECT status FROM loop_jobs WHERE id=?').get(imported.body.job_id).status==='done')
  pending[0]();await new Promise(r=>setTimeout(r,80))
  assert.equal(f.rt.db.prepare('SELECT COUNT(*) AS n FROM loop_rules').get().n,1)
  assert.equal(f.rt.db.prepare('SELECT status FROM loop_jobs WHERE id=?').get(imported.body.job_id).status,'done')
})

test('editing a rule invalidates a conflict decision made for older versions', async t => {
  const f=fixture();t.after(()=>f.close());insertRule(f)
  insertRule(f,{id:'rule-2',strength:'must',actions_json:'[{"type":"allow","target":"delete"}]'})
  const conflict=(await f.request('/rules/conflicts')).body.items[0]
  assert.equal((await f.request(`/rules/conflicts/${encodeURIComponent(conflict.key)}/resolve`,{resolution:'prefer_a'})).status,200)
  await f.request('/rules/rule-2',{description:'new reviewed version'},'PATCH')
  const updated=(await f.request('/rules/conflicts')).body.items[0]
  assert.equal(updated.adjudicated,false)
})

test('ChatGPT export preserves the selected branch and text parts', () => {
  const message = (id, role, text, time) => ({ id, author: { role }, content: { content_type: 'text', parts: [text] }, create_time: time })
  const result = parseJsonConversation({ current_node: 'selected', mapping: {
    root: { parent: null, message: message('u', 'user', '任务', 1) },
    rejected: { parent: 'root', message: message('bad', 'assistant', '已否决答案', 2) },
    selected: { parent: 'root', message: message('good', 'assistant', '最终答案', 3) },
  } })
  assert.deepEqual(result.messages.map(m => m.content), ['任务', '最终答案'])
})

test('extraction covers the tail of a long original message', async t => {
  const f = fixture({ loopWorker: true, loopWorkerIntervalMs: 40 })
  const originalFetch = globalThis.fetch; const sent = []
  globalThis.fetch = async (_, init) => { sent.push(JSON.parse(init.body).messages[1].content); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"memories":[],"rules":[]}' } }] }) } }
  t.after(() => { globalThis.fetch = originalFetch; f.close() })
  await extract(f, [{ role: 'user', content: '前'.repeat(6500) + 'END_OF_LONG_MESSAGE' }])
  assert.ok(sent.some(text => text.includes('END_OF_LONG_MESSAGE')))
})

test('assistant evidence cannot confirm a fact or advance current ontology state', async t => {
  const f = fixture({ loopWorker: true, loopWorkerIntervalMs: 40 })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ memories: [{ type: 'fact', text: 'WELL_003 当前检修', subject: 'WELL_003', predicate: 'status', value: 'maintenance', source_category: 'user_statement', needs_confirmation: true, evidence_message_ids: ['m1'] }] }) } }] }) })
  t.after(() => { globalThis.fetch = originalFetch; f.close() })
  await extract(f, [{ role: 'assistant', content: '建议 WELL_003 检修' }])
  assert.equal(f.rt.db.prepare('SELECT status FROM loop_memories').get().status, 'proposed')
  assert.equal(f.rt.db.prepare('SELECT COUNT(*) AS n FROM loop_state_history').get().n, 0)
})

test('a negated maintenance statement cannot set the current state to maintenance', async t => {
  const f=fixture({loopWorker:true,loopWorkerIntervalMs:40});const originalFetch=globalThis.fetch
  globalThis.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({memories:[{type:'fact',text:'WELL_003 尚未检修',subject:'WELL_003',predicate:'status',value:'maintenance',source_category:'user_statement',evidence_message_ids:['m1']}]})}}]})})
  t.after(()=>{globalThis.fetch=originalFetch;f.close()})
  await extract(f,[{role:'user',content:'WELL_003 尚未检修'}])
  assert.equal(f.rt.db.prepare('SELECT COUNT(*) AS n FROM loop_state_history').get().n,0)
})

test('skill derivation is limited to the requested project', async t => {
  const f=fixture({loopWorker:true,loopWorkerIntervalMs:40});const originalFetch=globalThis.fetch
  globalThis.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({memories:['先检查输入','再生成材料'].map(text=>({type:'method',text,scope_type:'project',evidence_message_ids:['m1']}))})}}]})})
  t.after(()=>{globalThis.fetch=originalFetch;f.close()})
  for(const project of ['p1','p2'])await extract(f,[{role:'user',content:'先检查输入，再生成材料'}],{project})
  const result=await f.request('/skills/derive',{project:'p1',min_memories:2})
  assert.equal(result.status,200)
  assert.deepEqual(f.rt.db.prepare('SELECT project FROM loop_skill_candidates').all().map(r=>r.project),['p1'])
})

test('equal memories from different projects retain separate evidence', async t => {
  const f = fixture({ loopWorker: true, loopWorkerIntervalMs: 40 }); const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ memories: [{ type: 'preference', text: '先给结论', scope_type: 'personal', source_category: 'user_statement', evidence_message_ids: ['m1'] }] }) } }] }) })
  t.after(() => { globalThis.fetch = originalFetch; f.close() })
  for (const project of ['p1', 'p2']) { await extract(f, [{ role: 'user', content: '先给结论' }], { project }); f.rt.db.prepare("UPDATE loop_memories SET protected=1 WHERE project='p1'").run() }
  const rows = f.rt.db.prepare('SELECT project,COUNT(*) AS n FROM loop_memories GROUP BY project ORDER BY project').all()
  assert.deepEqual(rows.map(r => [r.project, r.n]), [['p1', 1], ['p2', 1]])
  assert.ok(f.rt.db.prepare('SELECT status FROM loop_memories').all().every(row=>row.status==='confirmed'))
  assert.equal(f.rt.db.prepare('SELECT COUNT(*) AS n FROM loop_memory_evidence e JOIN loop_memories m ON m.id=e.memory_id JOIN loop_messages msg ON msg.id=e.message_id JOIN loop_sources s ON s.id=msg.source_id WHERE m.project<>s.project').get().n, 0)
})

test('edited conversation imports preserve new evidence without duplicate failure', async t => {
  const f = fixture(); t.after(() => f.close())
  const send = contents => f.request('/import', { text: JSON.stringify(contents.map(content => ({ role: 'user', content }))), format: 'json', externalConversationId: 'same-conversation' })
  assert.equal((await send(['A', 'B'])).status, 200)
  const edited = await send(['A', 'EDIT', 'C'])
  assert.equal(edited.status, 200)
  assert.deepEqual(f.rt.db.prepare('SELECT content FROM loop_messages ORDER BY ordinal').all().map(r => r.content), ['A', 'B', 'EDIT', 'C'])
})
