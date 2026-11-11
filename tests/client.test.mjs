import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { compileContext } from '../lib/context-compiler.js'

async function probe(options = {}) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const effects=[]; const updates=[]
  let stateIndex=0
  const React = {
    createElement: (...args) => ({ args }),
    useMemo: (fn) => fn(), useRef: (v) => ({ current: v }),
    useState: (v) => { const index=stateIndex++; return [options.stateValues?.[index] ?? (typeof v === 'function' ? v() : v), value => updates.push(value)] },
    useCallback: (fn) => fn, useEffect: fn => effects.push(fn),
  }
  const window = { location: { protocol: 'http:', origin: 'http://localhost', search: '', ...options.location }, addEventListener() {}, removeEventListener() {}, fetch: options.fetch || (() => {}) }
  let plugin; const views = new Map();const listeners=new Map();const disposers=[]
  let rows=options.hostRows || [{moduleName:'@fuxing/dsh-brain',enabled:true,fiberPhase:'active'}]
  const install=effect=>{
    if(typeof effect==='function')return effect
    if(effect && typeof effect[Symbol.iterator]==='function'){const undo=[...effect].filter(value=>typeof value==='function');return ()=>undo.reverse().forEach(fn=>fn())}
    return ()=>{}
  }
  const listen=(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);return ()=>listeners.get(name)?.delete(fn)}
  window.__ModuleLoader__ = { load({ factory }) { plugin = factory((id) => id === 'react' ? React : {}) } }
  vm.runInNewContext(source, { window, URL, URLSearchParams, fetch: window.fetch, localStorage: { getItem() {}, setItem() {} }, console, setInterval, clearInterval })
  await plugin.apply({
    slots: {inject:(_,fn)=>install(fn()),register:(meta,component)=>{views.set(meta.id,component);return ()=>views.delete(meta.id)}},
    remote:{pluginManager:{listPlugins:async()=>({ok:true,value:rows})},$on:listen},
    remoteAccess:{whenAccess:(_,fn)=>install(fn())},on:listen,
    effect:fn=>{const undo=install(fn());disposers.push(undo);return undo},
  })
  return { ...window.__memoryBrainClientTest, views, window, effects, updates,
    async hostRows(next){rows=next;await Promise.all([...(listeners.get('plugin-manager/changed') || [])].map(fn=>fn()))},
    dispose(){disposers.reverse().forEach(fn=>fn())},listeners,
  }
}

test('disabling the host plugin removes both tabs and enabling it restores a single pair',async()=>{
 const api=await probe()
 assert.equal(api.views.size,2)
 await api.hostRows([{moduleName:'@fuxing/dsh-brain',enabled:false,fiberPhase:null}])
 assert.equal(api.views.size,0)
 await api.hostRows([{moduleName:'@fuxing/dsh-brain',enabled:true,fiberPhase:'active'}])
 assert.equal(api.views.size,2)
 api.dispose();assert.equal(api.views.size,0)
 assert.equal(api.listeners.get('plugin-manager/changed')?.size || 0,0)
})

test('an initially disabled host never mounts views or requests its removed HTTP routes',async()=>{
 const requests=[]
 const api=await probe({hostRows:[],fetch:async path=>{requests.push(path);return {ok:false,status:404}}})
 assert.equal(api.views.size,0);assert.equal(requests.length,0)
 api.dispose()
})

test('a late configuration response cannot restore tabs after the host was disabled',async()=>{
 const api=await probe({hostRows:[]})
 let release
 api.window.fetch=()=>new Promise(resolve=>{release=resolve})
 const enabling=api.hostRows([{moduleName:'@fuxing/dsh-brain',enabled:true,fiberPhase:'active'}])
 await new Promise(resolve=>setTimeout(resolve,5))
 assert.equal(typeof release,'function')
 await api.hostRows([])
 release({ok:true,json:async()=>({ok:true,prefix:'/memory-brain'})})
 await enabling
 assert.equal(api.views.size,0)
 api.dispose()
})

test('client synthetic probe exposes sent-record normalization and stable mode key', async () => {
  const api = await probe()
  assert.deepEqual(JSON.parse(JSON.stringify(api.normalizeRecords({ items: [
    { invocation_id: 'i1', sent: { text: '事实', version: 3 }, sent_at: '2026-01-01' },
    { invocation_id: 'i2', status: 'running' },
    { id: 'i3', context_run_id: 'r3', context: { text: 'ctx' } },
  ] }))), [
    { id: 'i1', sent: { text: '事实', version: 3 }, version: 3, feedback: null, sentAt: '2026-01-01' },
  ])
  assert.equal(api.storageKey('conversation-7'), 'memory-brain:mode:conversation-7')
})

test('client source keeps additive conversation.view', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /conversation\.view/)
  assert.doesNotMatch(source, /register\(\{\s*name:\s*['"]root['"]/)
  assert.match(source, /实际带入模型的记忆/)
})

test('client normalizes actual sent records from the real host list shape', async () => {
  const api = await probe()
  const rows = api.normalizeRecords([{ invocation_id: 'sent', sent: { text: 'fact' }, sent_at: 'now' }, { invocation_id: 'candidate', context_run_id: 'run', context: { text: 'not sent' } }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'sent')
})

test('record read failures cannot masquerade as an empty memory history', async () => {
 const api=await probe()
 await assert.rejects(()=>api.getRecords('s',async()=>({ok:false,status:500})),/500/)
 await assert.rejects(()=>api.getRecords('s',async()=>{throw new Error('offline')}),/offline/)
})

function elements(node) {
  if (!node?.args) return []
  return [node, ...node.args.slice(2).flat(Infinity).flatMap(elements)]
}

test('automatic chat extraction shows real progress and can be disabled without entering IDs',async()=>{
 const requests=[]
 const api=await probe({stateValues:{6:{mode:'auto',auto_extract:true,auto_extraction:{status:'done',memories_added:2,rules_added:1}}},fetch:async(path,init={})=>{requests.push({path,body:init.body&&JSON.parse(init.body)});return {ok:true,json:async()=>({scope:{mode:'auto',auto_extract:false}})}}})
 const view=api.views.get('memory-chat')({sessionId:'s'})
 assert.match(JSON.stringify(view),/新增 2 条记忆/)
 const checkbox=elements(view).find(node=>node.args[0]==='input'&&node.args[1]?.type==='checkbox')
 assert.ok(checkbox);await checkbox.args[1].onChange({target:{checked:false}})
 assert.ok(requests.some(request=>request.body?.conversation_id==='s'&&request.body.auto_extract===false))
})

test('actual memory content and evidence are visible immediately without expanding a call record', async () => {
 const sent=compileContext({ok:true,sections:{task_background:{task:'检查油井'},facts:[{id:'f',text:'WELL_001 正在检修',evidence:[{source_title:'现场记录',quote:'今天开始检修'}]}]}})
 const api=await probe({stateValues:{1:[{id:'i',sent,sentAt:'2026-11-10'}],6:{mode:'auto'}},fetch:async()=>({ok:true,json:async()=>({})})})
 const view=api.views.get('memory-chat')({sessionId:'s'})
 const visible=node=>!node?.args?[]:[node,...(node.args[0]==='details' && !node.args[1]?.open?[]:node.args.slice(2).flat(Infinity).flatMap(visible))]
 const text=visible(view).flatMap(node=>node.args.slice(2).filter(value=>typeof value==='string')).join(' ')
 assert.match(text,/WELL_001 正在检修/);assert.match(text,/今天开始检修/);assert.match(text,/现场记录/)
 assert.match(text,/检查油井/)
 assert.equal(visible(view).filter(node=>node.args[0]==='pre').length,0)
})

test('an empty context is explained and the graph button opens the existing brain view', async () => {
 const sent=compileContext({ok:true,sections:{}});const opened=[]
 const api=await probe({stateValues:{1:[{id:'i',sent,sentAt:'2026-11-10'}],6:{mode:'auto'}}})
 const view=api.views.get('memory-chat')({sessionId:'s',openView:(...args)=>opened.push(args)})
 assert.match(JSON.stringify(view),/这次没有匹配到可直接使用的记忆/)
 assert.doesNotMatch(JSON.stringify(view),/首次提问后自动识别/)
 const button=elements(view).find(node=>node.args[0]==='button'&&node.args[2]==='查看完整记忆图谱')
 button.args[1].onClick();assert.deepEqual(opened,[['memory-brain','graph']])
})

test('the graph focus opens the real database workspace in the brain iframe', async () => {
 const api=await probe()
 const view=api.views.get('memory-brain')({viewRequest:{view:'memory-brain',focus:'graph'}})
 const frame=elements(view).find(node=>node.args[0]==='iframe')
 assert.equal(new URL(frame.args[1].src,'http://localhost').searchParams.get('ui'),'graph')
})

test('the default memory view shows automatic context without a parameter form', async () => {
 const api=await probe({stateValues:{6:{mode:'auto',project_id:'pumping-well',project_name:'pumping-well',task_description:'检查项目',auto_scope:{}}}})
 const view=api.views.get('memory-chat')({sessionId:'s'})
 const visible=node=>!node?.args?[]:[node,...(node.args[0]==='details' && !node.args[1]?.open?[]:node.args.slice(2).flat(Infinity).flatMap(visible))]
 assert.equal(visible(view).filter(node=>node.args[0]==='input').length,0)
 const text=JSON.stringify(view)
 assert.match(text,/无需填写/);assert.match(text,/pumping-well/);assert.match(text,/检查项目/)
 const advanced=elements(view).find(node=>node.args[0]==='details')
 assert.ok(advanced);assert.ok(!advanced.args[1]?.open)
})

test('a refresh finishing after unmount cannot overwrite another session', async () => {
 let release
 const waiting=new Promise(resolve=>{release=resolve})
 const api=await probe({fetch:async path=>{
   if(path.includes('/scope?')) {await waiting;return {ok:true,json:async()=>({scope:{mode:'off',project_id:'old'}})}}
   return {ok:true,json:async()=>[]}
 }})
 api.views.get('memory-chat')({sessionId:'old'})
 const cleanup=api.effects[0]()
 cleanup()
 const before=api.updates.length
 release();await new Promise(resolve=>setTimeout(resolve,10))
 assert.equal(api.updates.length,before)
})

test('choosing off persists the backend scope before changing the UI', async () => {
  const requests=[]
  const api=await probe({fetch:async(path,init={})=>{requests.push({path,body:init.body && JSON.parse(init.body)});return {ok:true,json:async()=>({ok:true,scope:{mode:'off'}})}}})
  const view=api.views.get('memory-chat')({sessionId:'s'})
  const select=elements(view).find(node=>node.args[0]==='select')
  await select.args[1].onChange({target:{value:'off'}})
  assert.ok(requests.some(r=>r.path.includes('/scope') && r.body?.mode==='off' && r.body.conversation_id==='s'))
})

test('ignore during a running turn targets the server current turn instead of a boolean flag', async () => {
  const requests=[]
  const api=await probe({fetch:async(path,init={})=>{requests.push({path,body:init.body && JSON.parse(init.body)});return {ok:true,json:async()=>({ok:true,scope:{mode:'auto',current_turn:7,turn_active:true}})}}})
  const view=api.views.get('memory-chat')({sessionId:'s'})
  await elements(view).find(node=>node.args[0]==='button' && node.args[2]==='仅本轮忽略').args[1].onClick()
  const ignored=requests.find(r=>r.body?.ignored_by_turn)
  assert.equal(ignored?.body.ignored_by_turn['7'],true)
})

test('the view refresh reads the persisted session mode from the server', async () => {
  const requests=[]
  const api=await probe({fetch:async path=>{requests.push(path);return {ok:true,json:async()=>path.includes('/scope')?{ok:true,scope:{mode:'off',project_id:'p1'}}:{ok:true,items:[]}}}})
  api.views.get('memory-chat')({sessionId:'s'})
  const cleanups=api.effects.map(effect=>effect())
  try {
    await new Promise(resolve=>setTimeout(resolve,10))
    assert.ok(requests.some(path=>path.includes('/scope?conversation_id=s')))
    assert.ok(api.updates.includes('off'))
  } finally { cleanups.forEach(cleanup=>cleanup?.()) }
})

test('health probes preserve query credentials and reject HTML success pages', async () => {
  const requests=[]
  const api=await probe({location:{search:'?token=test-token'},fetch:async path=>{requests.push(path);return {ok:true,json:async()=>{throw new Error('HTML response')}}}})
  api.views.get('memory-brain')({})
  const cleanup=api.effects[0]()
  await new Promise(resolve=>setTimeout(resolve,10)); cleanup?.()
  const url=new URL(requests.find(path=>String(path).includes('api/health')))
  assert.equal(url.pathname,'/memory-brain/api/health')
  assert.equal(url.searchParams.get('token'),'test-token')
  assert.ok(api.updates.includes('fail'))
})

test('client discovers the configured server prefix', async () => {
  const requests=[]
  const api=await probe({fetch:async path=>{requests.push(path);return {ok:true,json:async()=>({ok:true,prefix:'/custom-brain',items:[]})}}})
  await api.getRecords('s',api.window.fetch)
  assert.ok(requests.some(path=>path.startsWith('/custom-brain/api/loop/invocations')))
})

test('preview confirmation sends the exact displayed fingerprint', async () => {
  const requests=[]
  const api=await probe({stateValues:{0:'preview',6:{mode:'preview',preview:{fingerprint:'shown-fingerprint',text:'facts'}}},fetch:async(path,init={})=>{requests.push({path,body:init.body&&JSON.parse(init.body)});return {ok:true,json:async()=>({ok:true,scope:{mode:'preview'}})}}})
  const view=api.views.get('memory-chat')({sessionId:'s'})
  const confirm=elements(view).find(node=>node.args[0]==='button' && node.args[2]==='确认这份预览')
  assert.ok(confirm)
  await confirm.args[1].onClick()
  assert.ok(requests.some(r=>r.body?.preview_approval==='shown-fingerprint'))
})

test('session bindings are saved to the same backend scope used by injection', async () => {
  const requests=[]
  const api=await probe({stateValues:{6:{mode:'auto'}},fetch:async(path,init={})=>{requests.push({path,body:init.body&&JSON.parse(init.body)});return {ok:true,json:async()=>({ok:true,scope:{mode:'auto'}})}}})
  const form=elements(api.views.get('memory-chat')({sessionId:'s'})).find(node=>node.args[0]==='form')
  assert.ok(form)
  await form.args[1].onSubmit({preventDefault(){},currentTarget:{elements:{project_id:{value:'p1'},task_id:{value:'t1'},task_description:{value:'report'},object_id:{value:'o1'}}}})
  assert.ok(requests.some(r=>r.body?.project_id==='p1'&&r.body?.task_id==='t1'&&r.body?.object_id==='o1'))
})
