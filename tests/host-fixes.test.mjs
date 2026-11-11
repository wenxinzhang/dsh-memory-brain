import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable, Writable } from 'node:stream'
import vm from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import { createDshIntegration } from '../lib/dsh-integration.js'
import { compileContext } from '../lib/context-compiler.js'
import { createExecutionStore } from '../lib/execution-store.js'
import { createRulesRuntime } from '../lib/rules.js'

const MEMORY = /MEMORY_BRAIN_CONTEXT_BEGIN/
const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content || []).map(p => p.text || '').join('')
const facts = (n, size) => Array.from({length:n}, (_, i) => ({id:`f${i}`, version:1, text:`${i}:${'y'.repeat(size)}`}))
const empty = () => (async function*(){ yield {type:'text', text:'ok'}; yield {type:'finish', reason:{kind:'stop'}} })()

// ---- P1: unknown model window ----

test('compileContext with an unknown window never fails closed and caps soft content by characters', () => {
  const hard = {sections:{constraints:[{id:'hard', text:'x'.repeat(50000)}], facts:facts(5, 100)}}
  const result = compileContext(hard, {requestTokens:1_000_000, maxChars:1000})
  assert.equal(result.budget, null)
  assert.match(result.text, /hard/)
  assert.equal(result.selected.memories.length, 1)
  const soft = compileContext({sections:{facts:facts(50, 200)}}, {contextWindow:0, maxChars:3000})
  assert.ok(soft.text.length <= 3000)
  assert.ok(soft.selected.memories.length > 0 && soft.selected.memories.length < 50)
})

test('the first turn of a long conversation is not failed when the model window is still unknown', async () => {
  const api = createDshIntegration({config:{reservedOutput:2048}, runtime:{buildContext:() => ({ok:true, sections:{facts:facts(3, 50)}})}, executionStore:{scope:() => ({})}})
  const history = [{role:'user', content:'x'.repeat(40000)}, {role:'assistant', content:'y'.repeat(40000)}]
  const messages = [{role:'user', content:'next question'}]
  const result = await api.onPreStep({agent:{session:{id:'s', deriveMessages:() => history}}, turn:1, step:1, messages}, () => ({kind:'enter', messages}))
  assert.equal(result.kind, 'enter')
  assert.ok(result.messages.some(m => MEMORY.test(textOf(m))))
})

// ---- P2: one output reserve for both guards ----

test('injected memory never pushes a request that fits the window over the stream budget', async () => {
  const session = {id:'s', requestContext:() => ({contextWindow:10000}), requestHeader:() => ({maxTokens:4000}), deriveMessages:() => history}
  const history = [{role:'user', content:'x'.repeat(24000)}]
  const api = createDshIntegration({config:{reservedOutput:2048}, runtime:{buildContext:() => ({ok:true, sections:{facts:facts(60, 400)}})}, executionStore:{scope:() => ({}), start(){}, finish(){}, sent(){}}})
  const messages = [{role:'user', content:'question'}]
  const result = await api.onPreStep({agent:{session}, turn:1, step:1, messages}, () => ({kind:'enter', messages}))
  assert.ok(result.messages.some(m => MEMORY.test(textOf(m))))
  const chunks = await Array.fromAsync(api.onStream({sessionId:'s', maxTokens:4000, messages:[...history, ...result.messages]}, empty))
  assert.equal(chunks.at(-1).type, 'finish')
})

// ---- P2: per-session state is released ----

test('turn end releases the prepared context so a later request cannot claim it', async () => {
  let sent = 0
  const api = createDshIntegration({runtime:{buildContext:() => ({ok:true, sections:{}})}, executionStore:{scope:() => ({}), start(){}, finish(){}, sent(){ sent++ }}})
  const session = {id:'s'}
  const messages = [{role:'user', content:'q'}]
  const result = await api.onPreStep({agent:{session}, turn:1, step:1, messages}, () => ({kind:'enter', messages}))
  await api.onSessionEvent(session, {seq:9, type:'turn/end', data:{turn:1, reason:{kind:'completed'}}})
  await Array.fromAsync(api.onStream({sessionId:'s', messages:result.messages}, empty))
  assert.equal(sent, 0)
})

test('a disposed session no longer drives the request budget guard', async () => {
  const handlers = new Map()
  createDshIntegration({ctx:{on:(name, fn) => handlers.set(name, fn)}, config:{reservedOutput:100}, executionStore:{start(){}, finish(){}}})
  assert.equal(typeof handlers.get('session/disposed'), 'function')
  const session = {id:'s', requestContext:() => ({contextWindow:1000})}
  handlers.get('agent/request')({agent:{session}, signal:new AbortController().signal}, () => ({}))
  const big = {sessionId:'s', messages:[{role:'user', content:'x'.repeat(8000)}]}
  await assert.rejects(() => Array.fromAsync(handlers.get('llm/stream')(big, empty)), /request_exceeds_model_budget/)
  handlers.get('session/disposed')(session)
  const chunks = await Array.fromAsync(handlers.get('llm/stream')(big, empty))
  assert.equal(chunks.at(-1).type, 'finish')
})

// ---- P2: "ignore this turn" between turns applies to the next turn ----

test('ignoring while idle skips memory for the next turn only', async () => {
  const db = new DatabaseSync(':memory:'); const store = createExecutionStore(db)
  try {
    const api = createDshIntegration({runtime:{buildContext:() => ({ok:true, sections:{facts:facts(1, 10)}})}, executionStore:store})
    const session = {id:'s'}
    const step = async turn => { const messages = [{role:'user', content:`q${turn}`}]; return api.onPreStep({agent:{session}, turn, step:1, messages}, () => ({kind:'enter', messages})) }
    const injected = result => result.messages.some(m => MEMORY.test(textOf(m)))
    await api.onSessionEvent(session, {seq:0, type:'turn/start', data:{turn:1}})
    assert.ok(injected(await step(1)))
    assert.equal(store.scope('s').turn_active, true)
    await api.onSessionEvent(session, {seq:5, type:'turn/end', data:{turn:1, reason:{kind:'error'}}})
    assert.equal(store.scope('s').turn_active, false)
    store.scope('s', {ignore_next_turn:true})
    await api.onSessionEvent(session, {seq:6, type:'turn/start', data:{turn:2}})
    assert.ok(!injected(await step(2)))
    assert.equal(store.scope('s').ignored_by_turn['2'], true)
    assert.equal(store.scope('s').ignore_next_turn, false)
    await api.onSessionEvent(session, {seq:9, type:'turn/end', data:{turn:2, reason:{kind:'error'}}})
    assert.ok(injected(await step(3)))
    assert.throws(() => store.scope('s', {ignore_next_turn:'yes'}), /invalid_ignore_next_turn/)
  } finally { db.close() }
})

test('the pre-step consumes a pending ignore even without a turn/start event', async () => {
  const db = new DatabaseSync(':memory:'); const store = createExecutionStore(db)
  try {
    const api = createDshIntegration({runtime:{buildContext:() => ({ok:true, sections:{}})}, executionStore:store})
    store.scope('s', {current_turn:1, turn_active:false, ignore_next_turn:true})
    const messages = [{role:'user', content:'q'}]
    const result = await api.onPreStep({agent:{session:{id:'s'}}, turn:2, step:1, messages}, () => ({kind:'enter', messages}))
    assert.ok(!result.messages.some(m => MEMORY.test(textOf(m))))
    assert.equal(store.scope('s').ignored_by_turn['2'], true)
  } finally { db.close() }
})

async function clientProbe(scope) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const requests = []
  const React = {createElement:(...args) => ({args}), useMemo:fn => fn(), useRef:v => ({current:v}), useState:v => [typeof v === 'function' ? v() : v, () => {}], useCallback:fn => fn, useEffect(){}}
  const fetch = async (path, init = {}) => { requests.push({path, body:init.body && JSON.parse(init.body)}); return {ok:true, json:async () => ({ok:true, scope})} }
  const window = {location:{protocol:'http:', origin:'http://localhost', search:''}, addEventListener(){}, removeEventListener(){}, fetch}
  let plugin; const views = new Map()
  window.__ModuleLoader__ = {load({factory}) { plugin = factory(id => id === 'react' ? React : {}) }}
  vm.runInNewContext(source, {window, URL, URLSearchParams, fetch, localStorage:{getItem(){}, setItem(){}}, console, setInterval, clearInterval})
  const install = effect => typeof effect === 'function' ? effect : () => {}
  await plugin.apply({
    slots:{inject:(_, fn) => { for (const value of fn()) void value; return () => {} }, register:(meta, component) => { views.set(meta.id, component); return () => {} }},
    remote:{pluginManager:{listPlugins:async () => ({ok:true, value:[{moduleName:'@fuxing/dsh-brain', enabled:true, fiberPhase:'active'}]})}, $on:() => () => {}},
    remoteAccess:{whenAccess:(_, fn) => install(fn())}, on:() => () => {}, effect:fn => install(fn()),
  })
  const walk = node => node && typeof node === 'object' ? [node, ...(node.args || []).flatMap(walk)] : Array.isArray(node) ? node.flatMap(walk) : []
  const view = views.get('memory-chat')({sessionId:'s'})
  await walk(view).find(n => n.args?.[0] === 'button' && n.args[2] === '仅本轮忽略').args[1].onClick()
  return requests.filter(r => r.body)
}

test('the ignore button targets the next turn when no turn is running', async () => {
  const [posted] = await clientProbe({mode:'auto', current_turn:7, turn_active:false})
  assert.deepEqual(posted.body, {conversation_id:'s', ignore_next_turn:true})
})

// ---- P3: execution ledger size and failure isolation ----

test('tool results are stored as a bounded redacted summary and the list omits large fields', () => {
  const db = new DatabaseSync(':memory:'); const store = createExecutionStore(db)
  try {
    store.start({invocation_id:'i1', conversation_id:'c'})
    store.finish('i1', {status:'completed', answer:'a'.repeat(5000)})
    store.tool({tool_call_id:'t1', invocation_id:'i1', name:'read', result:{api_key:'secret', body:'z'.repeat(50000)}})
    const tool = store.get('i1').tools[0]
    assert.equal(tool.result, undefined)
    assert.equal(tool.result_preview.length, 2000)
    assert.ok(tool.result_chars > 50000 && tool.result_truncated)
    assert.match(tool.result_sha256, /^[0-9a-f]{64}$/)
    assert.ok(!JSON.stringify(tool).includes('secret'))
    assert.equal(store.get('i1').answer.length, 5000)
    const [row] = store.list('c')
    assert.equal(row.tools, undefined); assert.equal(row.answer, undefined)
    assert.equal(row.tool_count, 1); assert.equal(row.answer_chars, 5000)
    assert.deepEqual(row.feedback, [])
  } finally { db.close() }
})

test('a failing execution ledger never breaks the model stream or the tool call', async () => {
  const warnings = []
  const fail = () => { throw new Error('disk full') }
  const api = createDshIntegration({logger:{warn:line => warnings.push(line)}, runtime:{buildContext:() => ({ok:true, sections:{}})}, executionStore:{scope:() => ({}), start:fail, sent:fail, finish:fail, tool:fail}})
  const messages = [{role:'user', content:'q'}]
  const result = await api.onPreStep({agent:{session:{id:'s'}}, turn:1, step:1, messages}, () => ({kind:'enter', messages}))
  const chunks = await Array.fromAsync(api.onStream({sessionId:'s', messages:result.messages}, empty))
  assert.deepEqual(chunks.map(c => c.type), ['text', 'finish'])
  assert.equal((await api.onPostExecute({name:'read', callId:'c', agent:{session:{id:'s'}}}, {ok:true}, () => ({kind:'accept'}))).kind, 'accept')
  assert.ok(warnings.some(line => line.includes('disk full')))
})

// ---- P2/P3: legacy rules.json persistence ----

const rulesFixture = (t, files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-rules-fix-'))
  t.after(() => rmSync(dir, {recursive:true, force:true}))
  mkdirSync(join(dir, 'corpus')); mkdirSync(join(dir, 'data'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}
const rulesRequest = async (runtime, path, body) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = body === undefined ? 'GET' : 'POST'
  const chunks = []; const res = new Writable({write(chunk, _, cb) { chunks.push(Buffer.from(chunk)); cb() }})
  res.writeHead = status => { res.status = status; return res }
  const ended = new Promise(resolve => res.on('finish', resolve))
  await runtime.handle(req, res, new URL(`http://localhost/api/rules${path}`)); await ended
  return {status:res.status, body:JSON.parse(Buffer.concat(chunks).toString() || 'null')}
}
const existingRules = JSON.stringify({candidates:[], rules:[{id:'r_keep', type:'boundary', condition:'', action:'保留的规则', loopRuleId:'loop-1'}]})

test('extraction as the first rules request keeps the existing rules.json content', async t => {
  const server = createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, {'Content-Type':'application/json'})
      res.end(JSON.stringify({choices:[{message:{content:'{"rules":[{"type":"preference","condition":"","action":"先给结论","confidence":0.9,"evidence":"先给结论"}]}'}}]}))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const dir = rulesFixture(t, {'data/rules.json':existingRules, 'corpus/a.md':'以后先给结论。'})
  const runtime = createRulesRuntime({root:dir, config:{corpus:join(dir, 'corpus'), workspace:dir, rulesEndpoint:`http://127.0.0.1:${server.address().port}/v1`}})
  assert.equal((await rulesRequest(runtime, '/extract', {})).status, 202)
  while (runtime.publicState().state === 'running') await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(runtime.publicState().state, 'done', runtime.publicState().error)
  const saved = JSON.parse(readFileSync(join(dir, 'data', 'rules.json'), 'utf8'))
  assert.deepEqual(saved.rules.map(r => r.id), ['r_keep'])
  assert.equal(saved.candidates.length, 1)
})

test('an unreadable rules.json is backed up before anything is written over it', async t => {
  const dir = rulesFixture(t, {'data/rules.json':'{not json'})
  const runtime = createRulesRuntime({root:dir, config:{corpus:join(dir, 'corpus'), workspace:dir}, logger:{warn(){}}})
  await runtime.loadStore()
  const backups = readdirSync(join(dir, 'data')).filter(name => name.includes('.corrupt-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(dir, 'data', backups[0]), 'utf8'), '{not json')
})

test('loading only links rules that were never linked, so governed SQLite state is not revived on restart', async t => {
  const dir = rulesFixture(t, {'data/rules.json':JSON.stringify({candidates:[], rules:[{id:'r_linked', action:'a', loopRuleId:'loop-1'}, {id:'r_old', action:'b'}]})})
  const adopted = []
  const runtime = createRulesRuntime({root:dir, config:{corpus:join(dir, 'corpus'), workspace:dir}, onAdopt:rule => { adopted.push(rule.id); return `loop-${rule.id}` }})
  await runtime.loadStore()
  assert.deepEqual(adopted, ['r_old'])
  const saved = JSON.parse(readFileSync(join(dir, 'data', 'rules.json'), 'utf8'))
  assert.equal(saved.rules.find(r => r.id === 'r_old').loopRuleId, 'loop-r_old')
})

test('concurrent rule decisions do not collide on one temporary file', async t => {
  const candidates = Array.from({length:6}, (_, i) => ({id:`c_${i}`, type:'preference', condition:'', action:`rule ${i}`}))
  const dir = rulesFixture(t, {'data/rules.json':JSON.stringify({candidates, rules:[]})})
  const runtime = createRulesRuntime({root:dir, config:{corpus:join(dir, 'corpus'), workspace:dir}})
  await runtime.loadStore()
  const results = await Promise.all(candidates.map(c => rulesRequest(runtime, '/approve', {id:c.id})))
  assert.deepEqual(results.map(r => r.status), Array(6).fill(200))
  assert.equal(JSON.parse(readFileSync(join(dir, 'data', 'rules.json'), 'utf8')).rules.length, 6)
  assert.ok(!readdirSync(join(dir, 'data')).some(name => name.endsWith('.tmp')))
})

test('withdrawing and re-adopting the same legacy rule keeps rules.json and the governed link in step', async t => {
  const dir = rulesFixture(t, {'data/rules.json':JSON.stringify({candidates:[{id:'c_x', type:'boundary', condition:'', action:'禁止删除'}], rules:[]})})
  const calls = []
  const runtime = createRulesRuntime({root:dir, config:{corpus:join(dir, 'corpus'), workspace:dir}, onAdopt:rule => { calls.push(['adopt', rule.id]); return 'loop-x' }, onWithdraw:id => calls.push(['withdraw', id])})
  await rulesRequest(runtime, '/approve', {id:'c_x'})
  await rulesRequest(runtime, '/delete', {id:'r_x'})
  const store = await runtime.loadStore(); store.candidates.push({id:'c_x', type:'boundary', condition:'', action:'禁止删除'})
  const again = await rulesRequest(runtime, '/approve', {id:'c_x'})
  assert.equal(again.body.rules[0].loopRuleId, 'loop-x')
  assert.deepEqual(calls, [['adopt', 'r_x'], ['withdraw', 'r_x'], ['adopt', 'r_x']])
})

// ---- host router: scope whitelist ----

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
let source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
source = source.replace("import z from '@deepseek-ai/schemastery'", `const field = () => ({ description() { return this }, default() { return this } }); const z = { object: x => x, string: field, number: field, boolean: field, enum: () => field() }`)
source = source.replace(/from '(\.\/[^']+)'/g, (_, p) => `from '${pathToFileURL(resolve(packageRoot, 'lib', p)).href}'`)
source = source.replace("fileURLToPath(new URL('../web', import.meta.url))", JSON.stringify(join(packageRoot, 'web')))
const { apply } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))

test('the scope API accepts an ignore-next-turn request', async t => {
  const root = mkdtempSync(join(tmpdir(), 'memory-host-fix-'))
  let handler; const disposers = []
  const ctx = {inject:(_, fn) => fn(ctx), get:() => undefined, on(){}, logger:{}, effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) }, webServer:{register(route) { if (route.kind === 'prefix') handler = route.handler; return () => {} }}}
  apply(ctx, {root, loopWorker:false, loopEmbedEnabled:false})
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); rmSync(root, {recursive:true, force:true}) })
  const req = Readable.from([Buffer.from(JSON.stringify({conversation_id:'s', ignore_next_turn:true}))]); req.method = 'POST'; req.url = '/memory-brain/api/loop/scope'; req.headers = {}
  const chunks = []; const res = new Writable({write(chunk, _, cb) { chunks.push(Buffer.from(chunk)); cb() }})
  res.writeHead = status => { res.status = status; return res }
  const ended = new Promise(resolve => res.on('finish', resolve))
  await handler(req, res); await ended
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(Buffer.concat(chunks).toString()).scope.ignore_next_turn, true)
  assert.ok(existsSync(join(root, 'data')))
})
