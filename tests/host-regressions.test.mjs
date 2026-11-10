import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable, Writable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { createExecutionStore } from '../lib/execution-store.js'
import { createLoopRuntime } from '../lib/loop.js'

// Exercise the actual host router with only the external configuration-schema builder stubbed.
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
let source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
source = source.replace("import z from '@deepseek-ai/schemastery'", `const field = () => ({ description() { return this }, default() { return this } }); const z = { object: x => x, string: field, number: field, boolean: field, enum: () => field() }`)
source = source.replace(/from '(\.\/[^']+)'/g, (_, p) => `from '${pathToFileURL(resolve(packageRoot, 'lib', p)).href}'`)
source = source.replace("fileURLToPath(new URL('../web', import.meta.url))", JSON.stringify(join(packageRoot, 'web')))
const { apply } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'memory-host-regression-'))
  let handler; const disposers = []; const handlers = new Map()
  const ctx = { inject: (_, fn) => fn(ctx), get: () => undefined, on: (name, fn) => handlers.set(name, fn), logger: {}, effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) }, webServer: { register(route) { if(route.kind==='prefix')handler = route.handler; return () => {} } } }
  apply(ctx, { root, loopWorker: false, loopEmbedEnabled: false })
  const request = async (path, body, headers = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = body === undefined ? 'GET' : 'POST'; req.url = '/memory-brain' + path; req.headers = headers
    const chunks = []; const res = new Writable({ write(chunk, _, cb) { chunks.push(Buffer.from(chunk)); cb() } })
    res.writeHead = (status, values) => { res.status = status; res.headers = values; return res }
    const ended = new Promise((resolve, reject) => { res.on('finish', resolve); res.on('error', reject) })
    await handler(req, res); await ended
    const raw = Buffer.concat(chunks).toString(); let bodyOut
    try { bodyOut = JSON.parse(raw) } catch {}
    return { status: res.status, body: bodyOut, raw }
  }
  return { root, handlers, request, async close() { for (const dispose of disposers.reverse()) await dispose(); rmSync(root, { recursive: true, force: true }) } }
}

test('scope shows live automatic extraction progress from its durable job',async t=>{
 const f=await fixture();t.after(()=>f.close())
 const runtime=createLoopRuntime({root:f.root,config:{loopWorker:false,loopEmbedEnabled:false}})
 try {
  const captured=runtime.captureChatTurn({conversation_id:'s',turn_id:1,messages:[{role:'user',content:'以后先给结论'}],modelSelection:{provider:'p',model:'m'}})
  createExecutionStore(runtime.db).scope('s',{auto_extraction:captured})
  runtime.db.prepare("UPDATE loop_jobs SET status='done',result_json=? WHERE id=?").run(JSON.stringify({memories_added:2,rules_added:1}),captured.job_id)
  const response=await f.request('/api/loop/scope?conversation_id=s')
  assert.equal(response.body.scope.auto_extraction.status,'done')
  assert.equal(response.body.scope.auto_extraction.memories_added,2)
  assert.equal((await f.request('/api/loop/scope',{conversation_id:'s',auto_extract:false})).body.scope.auto_extract,false)
 } finally{runtime.close()}
})

test('explicit scope edits revoke automatic ownership even when the value is unchanged', async t => {
 const f=await fixture();t.after(()=>f.close())
 const db=new DatabaseSync(join(f.root,'data','loop.db'))
 try {
  createExecutionStore(db).scope('s',{task_description:'A task',object_id:'auto-a',object_name:'Object A',auto_scope:{task_description:'A task',object_id:'auto-a',object_name:'Object A'}})
  const saved=await f.request('/api/loop/scope',{conversation_id:'s',task_description:'A task',object_id:'manual-object'})
  assert.equal(saved.body.scope.auto_scope.task_description,undefined)
  assert.equal(saved.body.scope.object_name,null)
  const messages=[{role:'user',content:'B task'}]
  await f.handlers.get('agent/pre-step')({agent:{session:{id:'s'}},turn:2,step:1,messages},()=>({kind:'enter',messages}))
  const scope=(await f.request('/api/loop/scope?conversation_id=s')).body.scope
  assert.equal(scope.task_description,'A task');assert.equal(scope.object_id,'manual-object');assert.equal(scope.object_name,null)
 } finally {db.close()}
})

test('host feedback preserves the original context correction protocol', async t => {
  const f = await fixture(); t.after(() => f.close())
  const context = await f.request('/api/loop/context', {})
  const response = await f.request('/api/loop/feedback', { run_id: context.body.run_id, outcome: 'useful', feedback: '确认有用' })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal((await f.request('/api/loop/feedback')).body.items.length, 1)
})

test('host static routes never serve runtime databases or private data files', async t => {
  const f = await fixture(); t.after(() => f.close())
  const db = await f.request('/data/loop.db')
  assert.equal(db.status, 403)
  writeFileSync(join(f.root, 'data', 'rules.json'), '{"private":true}')
  assert.equal((await f.request('/data/rules.json')).status, 403)
  writeFileSync(join(f.root, 'data', 'sample-payload.json'), '{"source":"sample"}')
  assert.equal((await f.request('/data/sample-payload.json')).status, 200)
})

test('host rejects writes from a foreign browser origin', async t => {
  const f = await fixture(); t.after(() => f.close())
  const response = await f.request('/api/loop/scope', { conversation_id: 'test', mode: 'off' }, { host: '127.0.0.1:8989', origin: 'https://untrusted.example' })
  assert.equal(response.status, 403)
  const local = await f.request('/api/loop/scope', { conversation_id: 'test', mode: 'off' }, { host: '127.0.0.1:8989', origin: 'http://127.0.0.1:8989' })
  assert.equal(local.status, 200)
})

test('a matching foreign Host and Origin do not bypass the loopback boundary', async t => {
  const f=await fixture();t.after(()=>f.close())
  const result=await f.request('/api/loop/scope',{conversation_id:'s',mode:'off'},{host:'untrusted.example:8989',origin:'http://untrusted.example:8989'})
  assert.equal(result.status,403)
})

test('headless profiles register memory hooks without a web server', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-headless-regression-')); const events = []; const disposers = []
  const ctx = { inject() {}, on(name) { events.push(name) }, effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) } }
  try { apply(ctx, { root, loopWorker: false, loopEmbedEnabled: false }); assert.ok(events.includes('llm/stream')) }
  finally { disposers.reverse().forEach(dispose => dispose()); rmSync(root, { recursive: true, force: true }) }
})

test('legacy rule adoption creates a governed SQLite candidate', async t => {
  const f=await fixture();t.after(()=>f.close())
  writeFileSync(join(f.root,'data','rules.json'),JSON.stringify({candidates:[{id:'c_old',type:'boundary',condition:'检修期间',action:'禁止删除',evidence:{source:'corpus/test.md',quote:'检修期间禁止删除'}}],rules:[]}))
  const adopted=await f.request('/api/rules/approve',{id:'c_old'})
  assert.equal(adopted.status,200)
  const rules=(await f.request('/api/loop/rules')).body.items
  assert.equal(rules.length,1)
  assert.equal(rules[0].governance_status,'candidate')
  assert.equal(rules[0].structure_status,'unstructured')
  assert.equal(rules[0].evidence[0].legacy_rule_id,'r_old')
})
