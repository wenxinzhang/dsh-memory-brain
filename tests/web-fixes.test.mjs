import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { esc, fmt } from '../web/src/util.js'
import { selectMemoryWindow } from '../web/src/memory-view.js'

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))
const FORMS_KEY = 'memory-brain:loop-forms'
const FILTERS_KEY = 'memory-brain:loop-filters'

function memoryStorage(data = {}) {
  return {
    data,
    getItem: (k) => (k in data ? JSON.stringify(data[k]) : null),
    setItem(k, v) { data[k] = JSON.parse(v) },
    removeItem(k) { delete data[k] },
  }
}

/** 在 vm 里打开闭环抽屉；api 调用全部记录到 calls。 */
function drawer({ api = {}, session = {}, win = {} } = {}) {
  let code = readFileSync(new URL('../web/src/ui/loop.js', import.meta.url), 'utf8')
  code = code.replace(/^import .*$/gm, '').replace('export function openLoop', 'function openLoop')
  const listeners = new Map()
  const body = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] }
  const root = {
    innerHTML: '', querySelector: () => body, querySelectorAll: () => [],
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn) },
  }
  const calls = []
  const toasts = []
  const sessionStorage = memoryStorage(session)
  const apiProxy = new Proxy({}, {
    get: (_, name) => async (...args) => {
      calls.push({ name, args })
      return api[name] ? api[name](...args) : { items: [], counts: {} }
    },
  })
  const document = { getElementById: () => root, body: { classList: { add() {}, remove() {} } }, addEventListener() {}, removeEventListener() {}, querySelector: () => null }
  const context = {
    document, window: { localStorage: memoryStorage(), sessionStorage, ...win }, api: apiProxy, esc, fmt,
    toast: (m) => toasts.push(m), console, setTimeout, clearTimeout, setInterval, clearInterval, Map, Set, Date, URLSearchParams,
  }
  vm.createContext(context)
  vm.runInContext(`${code}\nthis.openLoop=openLoop`, context)
  const fire = async (name, event) => { for (const fn of [...(listeners.get(name) || [])]) await fn(event) }
  const element = (selectors, props = {}) => {
    const el = { ...props, matches: (sel) => selectors.includes(sel), closest: (sel) => (selectors.includes(sel) ? el : props.closest?.(sel) ?? null) }
    return el
  }
  return {
    body, calls, toasts, sessionStorage,
    open: (options) => context.openLoop(options),
    callsOf: (name) => calls.filter((c) => c.name === name),
    action: (loopAction, { id = '', dataset = {}, panel = null } = {}) => fire('click', {
      target: { closest: (sel) => (sel === '[data-loop-action]' ? { dataset: { loopAction, id, ...dataset }, disabled: false, closest: () => panel } : null) },
    }),
    tab: (view) => fire('click', { target: { closest: (sel) => (sel === '[data-view]' ? { dataset: { view } } : null) } }),
    change: (el) => fire('change', { target: el }),
    input: (el) => fire('input', { target: el }),
    element,
    close: () => fire('click', { target: { closest: (sel) => (sel === '[data-close]' ? {} : null) } }),
  }
}

const panelOf = (values) => ({ querySelector: (sel) => (sel in values ? { value: values[sel], checked: false } : null) })

test('memory edit sends the raw object_value text and the drawer owner', async () => {
  const d = drawer({ session: { [FORMS_KEY]: { owner: 'alice' } } })
  d.open({ view: 'memory' })
  await wait()
  try {
    assert.match(d.callsOf('loopMemories').at(-1).args[0], /owner=alice/)
    assert.match(d.callsOf('loopOverview').at(-1).args[0], /owner=alice/)
    const raw = '{"well":"W1","rate":12}'
    await d.action('mem-edit-save', { id: 'm1', panel: panelOf({ '[data-mem-text]': '', '[data-mem-object]': raw }) })
    const [id, body] = d.callsOf('loopPatchMemory').at(-1).args
    assert.equal(id, 'm1')
    assert.equal(typeof body.object_value, 'string')
    assert.equal(body.object_value, raw)
    assert.equal(body.owner, 'alice')
  } finally { await d.close() }
})

test('owner typed in the import form scopes later lists, details and writes, and survives reopening', async () => {
  const d = drawer()
  d.open({ view: 'import' })
  await wait()
  assert.match(d.callsOf('loopImports').at(-1).args[0], /owner=local-user/)
  const ownerInput = d.element(['[data-owner]'], { value: 'bob' })
  await d.input(ownerInput)
  await d.change(ownerInput)
  await wait()
  try {
    assert.match(d.callsOf('loopImports').at(-1).args[0], /owner=bob/)
    await d.action('source-detail', { id: 's1' })
    assert.deepEqual(d.callsOf('loopImportDetail').at(-1).args, ['s1', '?owner=bob'])
    await d.action('memory-detail', { id: 'm9' })
    assert.deepEqual(d.callsOf('loopMemory').at(-1).args, ['m9', '?owner=bob'])
    await d.action('instance-state', { id: 'i1', panel: panelOf({ '[data-state-select]': 'running', '[data-state-reason]': '' }) })
    assert.equal(d.callsOf('loopSetInstanceState').at(-1).args[2], '?owner=bob')
    await d.action('archive-rule', { id: 'r1' })
    assert.equal(d.callsOf('loopArchiveRule').at(-1).args[1].owner, 'bob')
    assert.equal(d.sessionStorage.data[FORMS_KEY].owner, 'bob')
  } finally { await d.close() }
  const again = drawer({ session: d.sessionStorage.data })
  again.open({ view: 'graph' })
  await wait()
  try { assert.match(again.callsOf('loopGraph').at(-1).args[0], /owner=bob/) } finally { await again.close() }
})

test('memory scope filter offers the backend scope enum and drops stale saved values', async () => {
  const d = drawer({ session: { [FILTERS_KEY]: { memory: { scope_type: 'global' } } } })
  d.open({ view: 'memory' })
  await wait()
  try {
    assert.doesNotMatch(d.callsOf('loopMemories').at(-1).args[0], /scope_type=/)
    for (const [value, label] of [['personal', '个人'], ['project', '项目'], ['task', '任务'], ['artifact', '业务对象'], ['domain', '领域']]) {
      assert.ok(d.body.innerHTML.includes(`<option value="${value}">${label}</option>`), value)
    }
    assert.doesNotMatch(d.body.innerHTML, /value="(global|object|user)"/)
  } finally { await d.close() }
})

test('projection toggle reflects the current central graph mode and follows graph filter changes', async () => {
  const projections = []
  const win = { __MB_GET_GRAPH_MODE__: () => 'loop', __MB_SET_GRAPH__: async (mode, opts) => { projections.push([mode, opts]); return {} } }
  const d = drawer({ win })
  d.open({ view: 'graph' })
  await wait()
  try {
    assert.match(d.body.innerHTML, /投射到中央大脑：开/)
    await d.change(d.element(['[data-filter]'], { dataset: { filter: 'graph.project' }, value: 'p1' }))
    await wait()
    assert.deepEqual(JSON.parse(JSON.stringify(projections.at(-1))), ['loop', { owner: 'local-user', project: 'p1', limit: 150 }])
    await d.action('graph-projection')
    assert.equal(projections.at(-1)[0], 'base')
  } finally { await d.close() }
})

test('late unfiltered rule load from the context view does not overwrite the filtered rules list', async () => {
  const api = {
    loopRules: async (query = '') => {
      if (/status=active/.test(query)) return { items: [{ id: 'ra', name: '筛选规则A', governance_status: 'active' }] }
      await wait(40)
      return { items: [{ id: 'rx', name: '无筛选规则X', governance_status: 'candidate' }] }
    },
  }
  const d = drawer({ api, session: { [FILTERS_KEY]: { rules: { view: 'all', status: 'active' } } } })
  d.open({ view: 'context' })
  await wait(1)
  await d.tab('rules')
  await wait(80)
  try {
    assert.match(d.body.innerHTML, /筛选规则A/)
    assert.doesNotMatch(d.body.innerHTML, /无筛选规则X/)
  } finally { await d.close() }
})

test('a slow earlier memory filter response is discarded in favour of the latest one', async () => {
  const api = {
    loopMemories: async (query = '') => {
      if (/type=fact/.test(query)) { await wait(40); return { items: [{ id: 'old', text: '旧筛选结果', status: 'confirmed' }] } }
      if (/type=method/.test(query)) return { items: [{ id: 'new', text: '新筛选结果', status: 'confirmed' }] }
      return { items: [] }
    },
  }
  const d = drawer({ api })
  d.open({ view: 'memory' })
  await wait()
  const typeFilter = (value) => d.element(['[data-filter]'], { dataset: { filter: 'memory.type' }, value })
  d.change(typeFilter('fact'))
  await wait(1)
  d.change(typeFilter('method'))
  await wait(80)
  try {
    assert.match(d.body.innerHTML, /新筛选结果/)
    assert.doesNotMatch(d.body.innerHTML, /旧筛选结果/)
  } finally { await d.close() }
})

test('archived rules show the archived label and no archive button', async () => {
  const api = { loopRules: async () => ({ items: [{ id: 'r1', name: '已归档规则', governance_status: 'archived' }] }) }
  const d = drawer({ api })
  d.open({ view: 'rules' })
  await wait()
  try {
    assert.match(d.body.innerHTML, /loop-badge archived">已归档/)
    assert.doesNotMatch(d.body.innerHTML, /loop-badge [a-z_]+">已被替代/)
    assert.doesNotMatch(d.body.innerHTML, /data-loop-action="archive-rule"/)
    assert.match(d.body.innerHTML, /<option value="archived">已归档<\/option>/)
  } finally { await d.close() }
})

test('rule edit shows structure status read-only and never sends it', async () => {
  const rule = { id: 'r1', name: 'R', governance_status: 'active', structure_status: 'unstructured', strength: 'must', conditions: {}, actions: [] }
  const d = drawer({ api: { loopRules: async () => ({ items: [rule] }) } })
  d.open({ view: 'rules' })
  await wait()
  try {
    await d.action('rule-edit-open', { id: 'r1' })
    assert.doesNotMatch(d.body.innerHTML, /data-rule-field="structure_status"/)
    assert.match(d.body.innerHTML, /结构状态<input value="待整理" readonly/)
    const values = { '[data-rule-json="conditions"]': '{}', '[data-rule-json="actions"]': '[]', '[data-rule-json="exceptions"]': '[]', '[data-rule-field="name"]': 'R2', '[data-rule-field="structure_status"]': 'structured' }
    await d.action('rule-edit-save', { id: 'r1', panel: panelOf(values) })
    const body = d.callsOf('loopPatchRule').at(-1).args[1]
    assert.equal(body.name, 'R2')
    assert.equal('structure_status' in body, false)
  } finally { await d.close() }
})

test('rule version history reads name and governance status from the version payload', async () => {
  const api = {
    loopRules: async () => ({ items: [{ id: 'r1', name: '当前名', governance_status: 'archived' }] }),
    loopRuleVersions: async () => ({ items: [
      { version: 2, payload: { name: '历史名称B', governance_status: 'paused' }, note: '改名', created_at: '2026-11-01T00:00:00Z' },
      { version: 1, name: '旧字段名称', status: 'confirmed', created_at: '2026-10-01T00:00:00Z' },
    ] }),
  }
  const d = drawer({ api })
  d.open({ view: 'rules' })
  await wait()
  try {
    await d.action('rule-versions', { id: 'r1' })
    assert.match(d.body.innerHTML, /历史名称B/)
    assert.match(d.body.innerHTML, /已暂停 ·/)
    assert.match(d.body.innerHTML, /旧字段名称/)
  } finally { await d.close() }
})

test('re-extract surfaces the queued job progress and errors instead of an empty batch card', async () => {
  const api = {
    loopExtract: async () => ({ ok: true, job: { id: 'j1', type: 'extract', status: 'queued' }, job_id: 'j1', status: 'queued' }),
    loopJob: async () => ({ job: { id: 'j1', type: 'extract', status: 'failed', error: '模型调用超时', progress_done: 1, progress_total: 3, attempts: 3, max_attempts: 3 } }),
  }
  const d = drawer({ api })
  d.open({ view: 'import' })
  await wait()
  try {
    await d.action('extract', { id: 's1' })
    await wait()
    assert.equal(d.callsOf('loopJob').at(-1).args[0], 'j1')
    assert.match(d.body.innerHTML, /任务详情 · j1/)
    assert.match(d.body.innerHTML, /模型调用超时/)
    assert.doesNotMatch(d.body.innerHTML, /拆解批次进度/)
  } finally { await d.close() }
})

test('review mode buttons and hint escape server-provided text', async () => {
  const mode = { id: '"><i>x</i>', name: '<img src=x onerror=1>', description: '<script>alert(1)</script>' }
  const d = drawer({ api: { loopReviewMode: async () => ({ mode: mode.id, modes: [mode] }) } })
  d.open({ view: 'rules' })
  await wait()
  try {
    assert.doesNotMatch(d.body.innerHTML, /<img|<script|"><i>/)
    assert.match(d.body.innerHTML, /&lt;img src=x onerror=1&gt;/)
    assert.match(d.body.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  } finally { await d.close() }
})

test('toolbar footer note is escaped', async () => {
  const { mount } = await import('../web/src/panels/toolbar.js')
  const button = { textContent: '', dataset: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, setAttribute() {}, addEventListener() {} }
  const el = { innerHTML: '', querySelector: () => button }
  mount(el, { footer: { note: '<img src=x onerror=alert(1)>' } })
  assert.doesNotMatch(el.innerHTML, /<img/)
  assert.match(el.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('3D loading errors keep the loading markup and stay hideable by class', () => {
  let code = readFileSync(new URL('../web/src/brain/mount.js', import.meta.url), 'utf8')
  code = code.replace(/^import .*$/gm, '').replace(/^export \{[^}]*\};?$/gm, '').replace(/^export /gm, '')
  const classes = new Set()
  const text = { textContent: '正在加载记忆皮层…' }
  const ring = {}
  const el = {
    style: {}, dataset: {}, textContent: null,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    querySelector: (sel) => (sel === '.ml-text' ? text : sel === '.ml-ring' ? ring : null),
  }
  const context = { document: { getElementById: () => el }, console, setTimeout, clearTimeout }
  vm.createContext(context)
  vm.runInContext(code, context)
  classes.add('is-hidden')
  context.show('三维场景创建失败：boom', true)
  assert.equal(text.textContent, '三维场景创建失败：boom')
  assert.equal(el.textContent, null, 'must not wipe .ml-ring/.ml-text')
  assert.equal(classes.has('is-error'), true)
  assert.equal(classes.has('is-hidden'), false)
  assert.equal(el.style.display, undefined, 'inline display would override .is-hidden')
  classes.add('is-hidden')
  assert.equal(el.style.display, undefined)
  context.show('正在加载…')
  assert.equal(classes.has('is-error'), false)
  context.hide()
  assert.equal(classes.has('is-hidden'), true)
  assert.equal(el.style.display, undefined)
})

test('time window keeps memories without a timestamp and counts them as unknown time', () => {
  const now = Date.parse('2026-11-10T00:00:00Z')
  const rows = [{ id: 1, kind: 'fact', created_at: now / 1000 }, { id: 2, kind: 'fact' }, { id: 3, kind: 'fact', created_at: 'not a date' }, { id: 4, kind: 'fact', created_at: now / 1000 - 90 * 86400 }]
  const out = selectMemoryWindow({ memories: rows, graph: { nodes: [], edges: [] } }, { range: '最近30天', tone: 'fact' }, now)
  assert.deepEqual(out.graph.memories.map((m) => m.id), [1, 2, 3])
  assert.equal(out.total, 3)
  assert.equal(out.unknownTime, 2)
  assert.equal(selectMemoryWindow({ memories: rows }, {}, now).total, 4)
})

test('payload without timeRange defaults to all time so historical memories render on first load', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ overview: {}, memories: [] }) })
  try {
    const { loadAll, clearCache } = await import('../web/src/api.js')
    clearCache()
    assert.equal((await loadAll()).overview.timeRange, '全部时间')
  } finally { globalThis.fetch = realFetch }

  const code = readFileSync(new URL('../web/src/app.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
  const old = Date.parse('2024-01-01T00:00:00Z') / 1000
  const rows = Array.from({ length: 5 }, (_, id) => ({ id, kind: 'fact', created_at: old - id }))
  const data = { overview: { loaded: 5, total: 5, memoryType: '全部类型' }, memories: rows, graph: { nodes: [], edges: [], memories: [] } }
  const graphs = []
  const element = { style: {}, hidden: false, querySelector: () => null, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} } }
  const panel = () => ({ setOverview() {}, setLoaded() {}, setStatus() {} })
  const context = { window: { addEventListener() {} }, location: { search: '' }, document: { getElementById: () => element, addEventListener() {} }, URLSearchParams, selectMemoryWindow, loadAll: async () => data, clearCache() {}, mountTopbar: panel, mountLeft: panel, mountRight: panel, mountToolbar: panel, mountBrain: async () => ({ setData: (g) => graphs.push(g) }), toast() {}, openRules() {}, openLoop() {}, icons: {}, console, setTimeout, clearTimeout }
  vm.createContext(context)
  vm.runInContext(code, context)
  await wait()
  assert.equal(graphs.at(-1)?.memories.length, 5)
  assert.equal(context.window.__MB_GET_GRAPH_MODE__(), 'base')
})
