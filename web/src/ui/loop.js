// loop.js — 记忆闭环抽屉 v2
// 视图：导入 / 记忆 / 本体 / 规则中心 / Skill 候选 / 上下文·反馈 / 图谱
// 契约：docs/loop-api-v2.md；所有请求通过 ../api.js；文案中文；用户文本一律 esc()。
import { esc, fmt } from '../util.js'
import { toast } from './overlays.js'
import * as api from '../api.js'

/* ------------------------------------------------------------------ 常量 */

const TABS = [
  ['import', '对话导入'],
  ['memory', '记忆'],
  ['ontology', '本体'],
  ['rules', '规则中心'],
  ['skills', 'Skill 候选'],
  ['context', '上下文/反馈'],
  ['graph', '图谱'],
]

const TYPE_LABEL = {
  fact: '事实', preference: '偏好', constraint: '约束', decision: '决策',
  event: '事件', todo: '待办', method: '方法',
}
const STATUS_LABEL = {
  proposed: '候选', needs_confirmation: '待确认', confirmed: '已确认', superseded: '已被替代',
  conflict: '冲突', archived: '已归档', deleted: '已删除',
}
const ROLE_LABEL = { user: '用户', assistant: '助手', system: '系统', tool: '工具', unknown: '未知' }
const ROLES = ['user', 'assistant', 'system', 'tool', 'unknown']
const STRENGTH = { must: '必须', must_not: '禁止', prefer: '偏好', suggest: '建议' }
const GOVERNANCE = {
  candidate: '候选', active: '已生效', paused: '已暂停',
  archived: '已归档', superseded: '已被替代',
}
const BATCH_STATUS = {
  queued: '排队中', running: '拆解中', partial: '部分完成', done: '已完成', failed: '失败',
}
const EXTRACT_STATUS = {
  raw_saved: '原文已保存', extracting: '拆解中', partial: '部分完成',
  done: '已拆解', error: '拆解失败', queued: '排队中', archived: '已归档',
}
const RULE_VIEW = { all: '全部', conflicts: '冲突', unstructured: '待整理' }
const RESOLUTION = { prefer_a: '优先采用 A', prefer_b: '优先采用 B', unresolved: '未裁决' }
const OUTCOME = {
  useful: '有用', problem: '有问题', incorrect: '内容不正确',
  not_executed: '未被遵守', tool_failure: '工具失败',
}
const CATEGORY = {
  rule_content: '规则内容', rule_scope: '规则适用范围', state: '状态理解',
  not_executed: '未执行', tool_failure: '工具失败',
}
const SKILL_STATUS = { candidate: '候选', confirmed: '已确认', rejected: '已忽略', archived: '已归档' }
const SKILL_ARRAY_LABEL = { inputs: '输入', preconditions: '前置条件', exceptions: '例外', boundaries: '边界' }
const GRAPH_TYPE = { memory: '记忆', object: '本体对象', rule: '规则' }
const GRAPH_COLOR = { memory: '#5ee7f2', object: '#f6b954', rule: '#ad74ff' }
const MAX_FILE = 20 * 1024 * 1024
const ALLOWED_EXT = ['json', 'md', 'markdown', 'txt']
const FORM_LIMIT = 4 * 1000 * 1000

const STORE_KEY = {
  view: 'memory-brain:loop-view',
  filters: 'memory-brain:loop-filters',
  forms: 'memory-brain:loop-forms',
  draft: 'memory-brain:loop-draft',
}

/* ------------------------------------------------------------------ 存储 */

function storeGet(kind, key, fallback) {
  try {
    const s = kind === 'session' ? window.sessionStorage : window.localStorage
    const raw = s.getItem(key)
    return raw == null ? fallback : JSON.parse(raw)
  } catch { return fallback }
}
function storeSet(kind, key, value) {
  try {
    const s = kind === 'session' ? window.sessionStorage : window.localStorage
    s.setItem(key, JSON.stringify(value))
  } catch {}
}
function readDraft() {
  try { return window.localStorage.getItem(STORE_KEY.draft) || '' } catch { return '' }
}

/* ------------------------------------------------------------------ 小工具 */

function opt(value, label, current) {
  return `<option value="${esc(value)}"${String(current) === String(value) ? ' selected' : ''}>${esc(label)}</option>`
}
function badge(text, cls = '') {
  return `<span class="loop-badge ${esc(cls)}">${esc(text)}</span>`
}
function stringify(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}
function stringifyPretty(v, fallback = '{}') {
  if (v == null) return fallback
  if (typeof v === 'string') return v
  try { return JSON.stringify(v, null, 2) } catch { return fallback }
}
function fmtTime(v) {
  if (v == null || v === '') return '—'
  if (typeof v === 'number') {
    const d = new Date(v > 1e12 ? v : v * 1000)
    if (!Number.isNaN(d.getTime())) return d.toLocaleString('zh-CN', { hour12: false })
  }
  const d = new Date(String(v))
  if (!Number.isNaN(d.getTime())) return d.toLocaleString('zh-CN', { hour12: false })
  return String(v)
}
function fmtBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / (1024 * 1024)).toFixed(2)} MB`
}
function fileExt(name) {
  const m = /\.([^.]+)$/.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}
function parseMaybeJson(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return undefined
  try { return JSON.parse(s) } catch { return s }
}
function setDeep(obj, path, value) {
  const keys = String(path || '').split('.')
  if (!keys.length) return
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  }
  cur[keys[keys.length - 1]] = value
}
function cssSafe(v) { return String(v).replace(/["\\]/g, '\\$&') }
function qs(params = {}) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') q.set(k, String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}
function toArray(v) {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}
function asItems(v) {
  if (v == null) return []
  if (Array.isArray(v)) return v
  if (typeof v === 'object') {
    return Object.entries(v)
      .filter(([, val]) => val != null && val !== '' && !(Array.isArray(val) && val.length === 0))
      .map(([k, val]) => (val && typeof val === 'object' && !Array.isArray(val) ? { text: k, ...val } : { text: `${k}: ${stringify(val)}` }))
  }
  return [v]
}
function itemText(x) {
  if (x == null) return ''
  if (typeof x === 'string' || typeof x === 'number') return String(x)
  return x.text || x.name || x.title || x.quote || x.reason || x.instruction || stringify(x)
}
function downloadText(text, filename) {
  try {
    const blob = new Blob([String(text || '')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = String(filename || 'skill.md').replace(/[\\/:*?"<>|]/g, '_')
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
    return true
  } catch {
    return false
  }
}
function validationError(message) {
  const e = new Error(message)
  e.validation = true
  return e
}
/** 兼容 host 迁移期的旧序列化（raw `_json` 字段 / list 路由回退）；v2 契约字段优先。 */
function parseJsonText(v, fallback) {
  if (v == null) return fallback
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return fallback }
}
function pickItem(out, id) {
  const items = Array.isArray(out && out.items) ? out.items : []
  return items.find((x) => x && String(x.id) === String(id)) || items[0] || null
}
function normalizeRule(r) {
  if (!r || typeof r !== 'object') return r
  return {
    ...r,
    conditions: r.conditions != null ? r.conditions : parseJsonText(r.conditions_json, {}),
    actions: r.actions != null ? r.actions : parseJsonText(r.actions_json, []),
    exceptions: r.exceptions != null ? r.exceptions : parseJsonText(r.exceptions_json, []),
    evidence: Array.isArray(r.evidence) ? r.evidence : parseJsonText(r.evidence_json, []),
  }
}

/* ------------------------------------------------------------------ 错误 */

const CODE_TITLE = {
  unit_conflict: '单位不兼容',
  type_mismatch: '属性类型不匹配',
  illegal_transition: '状态转换非法',
  relation_endpoint_mismatch: '关系端点类型不匹配',
  hard_constraints_exceed_budget: '硬约束超出预算',
}

function errorInfo(e) {
  const status = Number(e && e.status) || 0
  const payload = (e && e.payload) || {}
  const code = payload.error || payload.code || ''
  let path = e && e.path ? String(e.path) : ''
  path = path.replace(/^https?:\/\/[^/]+/, '')
  let title = '请求失败'
  let message = String((e && e.message) || e || '未知错误')
  let advice = '请稍后重试；若持续失败，查看 host 日志。'
  if (e && e.validation) {
    title = '检查未通过'
    advice = '修正后重试。'
  } else if (e && e.network) {
    title = '无法连接接口'
    advice = '确认页面与 /api/loop 服务已启动；刚升级插件时请重启 DSH。'
  } else if (status === 401 || status === 403) {
    title = '无权限访问'
    message = payload.error || payload.message || '当前会话无权访问该接口。'
    advice = '确认当前 owner（默认 local-user）与页面登录状态。'
  } else if (status === 404) {
    title = '接口或数据不存在'
    advice = '刚升级插件时请重启 DSH，让 host 加载新版 /api/loop；若数据已删除，刷新列表。'
  } else if (status === 503) {
    title = '服务暂不可用'
    advice = '本机记忆服务未就绪或模型不可用；稍后重试，原文不会丢失。'
  } else if (status === 409) {
    title = CODE_TITLE[code] || '操作被拒绝'
    advice = '按提示修正后重试。'
  }
  if (code === 'unit_conflict') {
    message = `单位不兼容：期望 ${payload.expected ?? '未给出'}，收到 ${payload.got ?? '未给出'}。`
    advice = '请换算为期望单位后重试；只有可换算单位才会自动转换。'
  } else if (code === 'type_mismatch') {
    message = `属性类型不匹配${payload.datatype ? `（期望 ${payload.datatype}）` : ''}。`
    advice = '检查值的类型（数字 / 文本 / 布尔 / 枚举）后重试。'
  } else if (code === 'illegal_transition') {
    message = `不允许从「${payload.from ?? '当前状态'}」转换到「${payload.to ?? '目标状态'}」。`
    advice = '按本体定义的状态机路径逐级转换。'
  } else if (code === 'relation_endpoint_mismatch') {
    message = `关系端点类型不匹配：期望 ${payload.expected ?? '—'}，收到 ${payload.got ?? '—'}。`
    advice = '选择与关系定义端点类型一致的实例。'
  } else if (code === 'hard_constraints_exceed_budget') {
    message = `硬约束文本 ${payload.hard_chars ?? '—'} 字符，超过预算 ${payload.budget ?? '—'}。`
    advice = '提高预算或减少必须遵守的硬约束。'
  }
  return { status, code, title, message, advice, path, expected: payload.expected, got: payload.got, payload }
}

function errorHtml(e, extra = '') {
  const info = errorInfo(e)
  const expGot = info.expected != null || info.got != null
    ? `<div class="loop-meta">expected: ${esc(stringify(info.expected))} · got: ${esc(stringify(info.got))}</div>` : ''
  return `<div class="loop-error-box" role="alert">
    <b>${esc(info.title)}</b>
    <p>${esc(info.message)}</p>
    ${expGot}
    ${info.code ? `<div class="loop-meta">错误码：${esc(info.code)}</div>` : ''}
    ${info.path ? `<div class="loop-path">接口：${esc(info.path)}</div>` : ''}
    <p class="loop-hint">${esc(info.advice)}</p>
    ${extra}
  </div>`
}

/* ------------------------------------------------------------------ 抽屉 */

export function openLoop(options = {}) {
  const root = document.getElementById('overlay-root')
  if (!root) return
  root.__memoryBrainClose?.()
  let closed = false
  const listeners = []
  const listen = (name, fn) => { root.addEventListener(name, fn); listeners.push(() => root.removeEventListener(name, fn)) }
  root.innerHTML = ''
  document.body.classList.add('overlay-open')

  const savedForms = storeGet('session', STORE_KEY.forms, {}) || {}
  const savedFilters = storeGet('session', STORE_KEY.filters, {}) || {}
  const savedView = storeGet('session', STORE_KEY.view, 'import')
  const initialView = TABS.some(([k]) => k === options.view) ? options.view : TABS.some(([k]) => k === savedView) ? savedView : 'import'
  const draft = readDraft()

  const state = {
    overview: null,
    view: initialView,
    loading: {},
    viewError: {},
    busy: false,
    reviewMode: null,
    reviewModes: null,
    forms: {
      import: {
        owner: 'local-user', project: '', task: '', platform: '',
        externalConversationId: '', title: '', filename: '', format: 'auto', autoExtract: '1',
        text: draft || '', ...(savedForms.import || {}),
      },
      skills: { project: '', min_memories: '3', ...(savedForms.skills || {}) },
      context: {
        owner: 'local-user', project: '', task: '', instruction: '', budget: '', includeSensitive: false, query: '',
        object: '{"object":{"name":"WELL_001"},"well":{"status":"maintenance"},"request":{"type":"solution"}}',
        ...(savedForms.context || {}),
      },
      action: { type: 'execute', target: 'parameter_optimization', authorized: false, note: '', ...(savedForms.action || {}) },
      feedback: {
        run_id: '', outcome: 'useful', category: '', feedback: '', rule_id: '', memory_id: '', correction: '',
        ...(savedForms.feedback || {}),
      },
    },
    filters: {
      memory: { type: '', status: '', scope_type: '', source_id: '', q: '', ...(savedFilters.memory || {}) },
      rules: { view: 'all', status: '', ...(savedFilters.rules || {}) },
      skills: { status: '', ...(savedFilters.skills || {}) },
      graph: { owner: 'local-user', project: '', ...(savedFilters.graph || {}) },
    },
    file: null,
    fileReading: false,
    attachments: [],
    preview: null,
    previewError: null,
    roleOverrides: {},
    importResult: null,
    archiveResult: null,
    archiveConfirm: '',
    imports: [],
    jobs: [],
    jobDetail: null,
    jobError: null,
    jobPollId: '',
    batches: [],
    batchSource: '',
    batchesError: null,
    extractStarting: {},
    extractResults: {},
    extractErrors: {},
    sourceDetail: null,
    memories: [],
    memSelected: new Set(),
    memEdit: null,
    memVersions: {},
    memDetail: null,
    mergePanel: false,
    mergeIds: '',
    ontology: null,
    ontologyVersions: [],
    ontologyVersionDiff: null,
    ontologyRollback: null,
    ontologyVersionLoading: false,
    ontologyVersionError: null,
    ontologyVersionNote: '',
    instDetails: {},
    opErrors: {},
    rules: [],
    ruleConflicts: [],
    conflictNotes: {},
    ruleConflictsLoading: false,
    ruleConflictsError: null,
    proposalResults: {},
    ruleSimOpen: '',
    ruleSim: {},
    ruleVersions: {},
    ruleEdit: null,
    ruleSupersede: null,
    skills: [],
    skillEdit: null,
    skillDerive: null,
    runs: [],
    feedbacks: [],
    contextResult: null,
    contextError: null,
    actionResult: null,
    actionError: null,
    actions: [],
    vectorStatus: null,
    vectorError: null,
    vectorJob: null,
    feedbackResult: null,
    graph: null,
    graphError: null,
    graphSelected: null,
    graphPage: 0,
    graphLayout: null,
    graphLayoutKey: '',
    graphProjection: 'base',
  }

  // localStorage 草稿优先于旧会话表单（会话里不保存大文本）
  if (!state.forms.import.text) state.forms.import.text = draft

  root.innerHTML = `
    <div class="scrim" data-close></div>
    <aside class="loop-drawer" role="dialog" aria-modal="true" aria-label="记忆闭环">
      <div class="loop-head">
        <div><div class="loop-title">记忆闭环</div><div class="loop-sub">IMPORT → ATOMIC MEMORY → ONTOLOGY → RULES → CONTEXT → FEEDBACK</div></div>
        <button class="drawer-close" type="button" data-close aria-label="关闭">✕</button>
      </div>
      <nav class="loop-tabs" role="tablist">${TABS.map(([k, l]) => `<button class="loop-tab" type="button" role="tab" data-view="${k}" aria-selected="${k === state.view}">${esc(l)}</button>`).join('')}</nav>
      <div class="loop-body" id="loop-body"></div>
      <div class="loop-foot">原话是证据；模型建议默认候选；规则确认后才参与上下文。所有写操作都记录审计。</div>
    </aside>`

  const bodyEl = root.querySelector('#loop-body')
  let view = state.view
  let pollTimer = 0
  let pollBusy = false
  let jobTimer = 0
  let draftTimer = 0
  let qTimer = 0
  let formTimer = 0

  const persistFilters = () => storeSet('session', STORE_KEY.filters, state.filters)
  const persistForms = () => {
    try {
      const copy = {
        import: { ...state.forms.import },
        skills: state.forms.skills,
        context: state.forms.context,
        feedback: state.forms.feedback,
      }
      delete copy.import.text
      storeSet('session', STORE_KEY.forms, copy)
    } catch {}
  }
  const schedulePersistForms = () => {
    clearTimeout(formTimer)
    formTimer = setTimeout(persistForms, 300)
  }
  const saveDraft = (text) => {
    clearTimeout(draftTimer)
    const value = String(text || '')
    draftTimer = setTimeout(() => {
      try {
        if (value.length > FORM_LIMIT) window.localStorage.removeItem(STORE_KEY.draft)
        else window.localStorage.setItem(STORE_KEY.draft, value)
      } catch {}
    }, 250)
  }
  const saveDraftNow = (text) => {
    const value = String(text || '')
    try {
      if (value.length > FORM_LIMIT) window.localStorage.removeItem(STORE_KEY.draft)
      else window.localStorage.setItem(STORE_KEY.draft, value)
    } catch {}
  }

  function close() {
    if (closed) return
    closed = true
    listeners.splice(0).forEach(dispose => dispose())
    root.__memoryBrainClose = null
    persistForms()
    persistFilters()
    saveDraftNow(state.forms.import.text)
    stopBatchPoll()
    stopJobPoll()
    clearTimeout(draftTimer)
    clearTimeout(qTimer)
    clearTimeout(formTimer)
    document.removeEventListener('keydown', onKey)
    root.innerHTML = ''
    document.body.classList.remove('overlay-open')
  }
  const onKey = (e) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  root.__memoryBrainClose = close

  /* ---------------------------------------------------------------- 通用渲染 */

  function stats() {
    const c = (state.overview && state.overview.counts) || {}
    const cells = [
      ['导入', c.sources], ['消息', c.messages], ['原子记忆', c.memories],
      ['规则', c.rules], ['本体实例', c.instances], ['Skill 候选', c.skills],
    ]
    return `<div class="loop-stats" id="loop-stats">${cells.map(([label, n]) => `<div class="loop-stat"><span>${esc(label)}</span><b>${fmt(n || 0)}</b></div>`).join('')}</div>`
  }
  const loadingBlock = (text) => `<div class="loop-empty loop-loading">${esc(text || '加载中…')}</div>`
  const emptyBlock = (text) => `<div class="loop-empty">${esc(text)}</div>`

  function setBusy(v) {
    state.busy = v
    if (v) {
      root.querySelectorAll('button[data-loop-action]').forEach((b) => {
        if (!b.disabled) { b.dataset.loopWasEnabled = '1'; b.disabled = true }
      })
    } else {
      root.querySelectorAll('button[data-loop-action]').forEach((b) => {
        if (b.dataset.loopWasEnabled) { b.disabled = false; delete b.dataset.loopWasEnabled }
      })
    }
  }

  function opErrorEl(key) {
    return bodyEl.querySelector(`[data-op-error="${cssSafe(key)}"]`)
  }
  function setOpError(key, e) {
    const target = opErrorEl(key)
    if (target) target.innerHTML = e ? errorHtml(e) : ''
    else toast(errorInfo(e).message || '操作失败', 3600)
  }

  /* ---------------------------------------------------------------- 数据读取 */

  async function refreshImports(throwOnError = false) {
    try {
      const out = await api.loopImports()
      state.imports = out.items || []
      state.viewError.import = null
    } catch (e) {
      if (throwOnError) throw e
      if (!state.imports.length) state.viewError.import = e
    }
  }
  async function refreshOverview() {
    try { state.overview = await api.loopOverview() } catch { /* 概览失败不阻塞视图 */ }
  }
  async function fetchMemories() {
    const f = state.filters.memory
    const out = await api.loopMemories(qs({
      type: f.type, status: f.status, scope_type: f.scope_type, source_id: f.source_id, q: f.q,
    }))
    state.memories = out.items || []
  }
  async function fetchRuleConflicts() {
    state.ruleConflictsLoading = true
    try {
      const out = await api.loopRuleConflicts()
      state.ruleConflicts = out.items || []
      state.ruleConflictsError = null
    } catch (e) {
      state.ruleConflictsError = e
    } finally {
      state.ruleConflictsLoading = false
    }
  }
  async function fetchRules() {
    const f = state.filters.rules
    const out = await api.loopRules(qs({ status: f.status, view: f.view === 'all' ? undefined : f.view }))
    state.rules = (out.items || []).map(normalizeRule)
    if (!state.reviewModes) { try { const rm = await api.loopReviewMode(); state.reviewMode = rm.mode; state.reviewModes = rm.modes } catch { /* 模式条缺失不影响规则列表 */ } }
    if (f.view === 'conflicts') await fetchRuleConflicts()
  }
  async function fetchSkills() {
    const out = await api.loopSkills(qs({ status: state.filters.skills.status }))
    state.skills = out.items || []
  }
  async function fetchGraph() {
    const f = state.filters.graph
    try {
      state.graph = await api.loopGraph(qs({ owner: f.owner, project: f.project, limit: 150 }))
      state.graphError = null
      state.graphLayout = null
      state.graphLayoutKey = ''
      state.graphPage = 0
      state.graphSelected = null
    } catch (e) {
      state.graphError = e
    }
  }
  async function refreshRunsAndFeedback() {
    const [runs, fbs, acts] = await Promise.all([
      api.loopRuns().catch(() => null),
      api.loopFeedbackList('?limit=20').catch(() => null),
      api.loopActions('?limit=10').catch(() => null),
    ])
    if (runs) state.runs = runs.items || []
    if (fbs) state.feedbacks = fbs.items || []
    if (acts) state.actions = acts.items || []
  }

  async function loadViewData(v) {
    if (v === 'import') { await refreshImports(true); await refreshJobs() }
    else if (v === 'memory') await fetchMemories()
    else if (v === 'ontology') { state.ontology = await api.loopOntology(); await refreshOntologyVersions() }
    else if (v === 'rules') await fetchRules()
    else if (v === 'skills') await fetchSkills()
    else if (v === 'context') {
      await refreshRunsAndFeedback()
      await refreshVectorStatus()
      try { state.rules = ((await api.loopRules()).items || []).map(normalizeRule) } catch { /* 反馈的 rule_id 下拉可为空 */ }
    }
    else if (v === 'graph') await fetchGraph()
  }

  async function loadView(v, { showLoading = true } = {}) {
    state.viewError[v] = null
    if (showLoading) {
      state.loading[v] = true
      render()
    }
    try {
      await loadViewData(v)
    } catch (e) {
      state.viewError[v] = e
    }
    if (closed) return
    state.loading[v] = false
    await refreshOverview()
    render()
  }

  /* ---------------------------------------------------------------- 批次轮询 */

  function stopBatchPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = 0 }
    pollBusy = false
  }

  function startBatchPoll(sourceId) {
    stopBatchPoll()
    state.batchSource = sourceId
    state.batches = []
    state.batchesError = null
    const tick = async () => {
      if (pollBusy) return
      pollBusy = true
      try {
        const out = await api.loopBatches(`?source_id=${encodeURIComponent(sourceId)}&limit=20`)
        state.batches = out.items || []
        state.batchesError = null
        updateBatchPanel()
        const active = state.batches.some((b) => ['queued', 'running'].includes(b.status))
        if (!active) {
          stopBatchPoll()
          await refreshImports()
          await refreshOverview()
          updateSourceList()
          updateBatchPanel()
          render()
        }
      } catch (e) {
        state.batchesError = e
        stopBatchPoll()
        updateBatchPanel()
      } finally {
        pollBusy = false
      }
    }
    tick()
    pollTimer = setInterval(tick, 1000)
  }

  function updateBatchPanel() {
    const el = bodyEl.querySelector('#loop-batch-panel')
    if (el) el.innerHTML = batchPanelHtml()
  }
  function updateSourceList() {
    const el = bodyEl.querySelector('#loop-source-list')
    if (el) el.innerHTML = sourceListHtml()
  }

  /* ---------------------------------------------------------------- 导入视图 */

  function importView() {
    const f = state.forms.import
    return `
      <div class="loop-card">
        <div class="loop-card-title">导入对话</div>
        <div class="loop-drop" id="loop-drop">
          <b>拖放文件到此处，或选择文件</b>
          <div class="loop-hint">支持 .json / .md / .markdown / .txt，单个文件 ≤ 20MB；前端会校验扩展名、大小与空文件。</div>
          <div class="loop-actions">
            <input type="file" id="loop-file" accept=".json,.md,.markdown,.txt" hidden>
            <button class="loop-btn" type="button" data-loop-action="pick-text-file">选择对话文件</button>
            <button class="loop-btn" type="button" data-loop-action="sample">填入 JSON 示例</button>
            ${state.file ? `<span class="loop-file-chip">已读取：${esc(state.file.name)} · ${fmtBytes(state.file.size)}<button class="loop-btn loop-btn-sm" type="button" data-loop-action="clear-file">移除</button></span>` : ''}
          </div>
          ${state.fileReading ? '<div class="loop-hint">正在读取文件…</div>' : ''}
        </div>
        <div class="loop-grid">
          <label>格式<select data-f="import.format">${opt('auto', '自动识别', f.format)}${opt('json', 'JSON', f.format)}${opt('text', 'Markdown / TXT', f.format)}</select></label>
          <label>归属用户<input data-f="import.owner" value="${esc(f.owner)}" placeholder="local-user"></label>
          <label>项目<input data-f="import.project" value="${esc(f.project)}" placeholder="可留空"></label>
          <label>任务<input data-f="import.task" value="${esc(f.task)}" placeholder="可留空"></label>
          <label>平台<input data-f="import.platform" value="${esc(f.platform)}" placeholder="如 chatgpt / dsh"></label>
          <label>外部会话 ID<input data-f="import.externalConversationId" value="${esc(f.externalConversationId)}" placeholder="相同会话会增量追加"></label>
          <label>文件名<input data-f="import.filename" value="${esc(f.filename)}" placeholder="可留空"></label>
          <label>标题<input data-f="import.title" value="${esc(f.title)}" placeholder="默认取文件名或首条用户消息"></label>
          <label>自动拆解<select data-f="import.autoExtract">${opt('1', '导入后拆解', f.autoExtract)}${opt('0', '只保存原文', f.autoExtract)}</select></label>
        </div>
        <textarea id="loop-text" class="loop-textarea" data-f="import.text" data-draft="1" placeholder="粘贴对话，或包含 用户:/User: 与 助手:/Assistant: 角色标记的文本；也支持 JSON（数组 / {messages} / ChatGPT mapping）">${esc(f.text || '')}</textarea>
        <div class="loop-actions">
          <button class="loop-btn" type="button" data-loop-action="preview">预览解析</button>
          <button class="loop-btn loop-btn-primary" type="button" data-loop-action="import">导入</button>
          <input type="file" id="loop-attach" multiple hidden>
          <button class="loop-btn" type="button" data-loop-action="pick-attachment">登记附件（仅元数据）</button>
        </div>
        ${attachmentsHtml()}
        <div class="loop-hint">导入只保存原文；拆解失败不会丢原文。附件只登记 name/size/type，内容未解析。</div>
      </div>
      ${previewHtml()}
      ${importResultHtml()}
      ${archiveResultHtml()}
      ${sourceDetailHtml()}
      <div id="loop-batch-panel">${batchPanelHtml()}</div>
      <div class="loop-card"><div class="loop-card-title">后台任务队列 <span class="loop-hint">（持久化 · 关闭页面/重启后继续）</span></div><div id="loop-job-panel">${jobPanelHtml()}</div></div>
      <div class="loop-card">
        <div class="loop-card-title">已导入来源 <span class="loop-hint">（消息数 / 附件 / 批次状态）</span></div>
        <div id="loop-source-list">${sourceListHtml()}</div>
      </div>`
  }

  function attachmentsHtml() {
    if (!state.attachments.length) return ''
    return `<div class="loop-attach-list">${state.attachments.map((a, i) => `<div class="loop-attach">
      <span>${esc(a.name)}</span>
      <span class="loop-meta">${fmtBytes(a.size)} · ${esc(a.type || '未知类型')} · 内容未解析</span>
      <button class="loop-btn loop-btn-sm" type="button" data-loop-action="remove-attachment" data-id="${i}">移除</button>
    </div>`).join('')}</div>`
  }

  function previewHtml() {
    if (state.previewError) {
      return `<div class="loop-card"><div class="loop-card-title">预览失败</div>${errorHtml(state.previewError)}</div>`
    }
    const p = state.preview
    if (!p) return ''
    const msgs = Array.isArray(p.messages) ? p.messages : []
    const warns = Array.isArray(p.warnings) ? p.warnings : []
    return `<div class="loop-card">
      <div class="loop-card-title">预览解析 · ${esc(p.format || 'auto')} · ${fmt(msgs.length)} 条消息${p.hash ? ` · ${esc(String(p.hash).slice(0, 8))}` : ''}</div>
      ${warns.length ? `<div class="loop-warn">${warns.map((w) => esc(String(w))).join('<br>')}</div>` : ''}
      <div class="loop-hint">逐条检查角色；无法识别的角色标黄。修正会以 1-based 下标（roleOverrides）随导入发送。</div>
      <div class="loop-list loop-preview">${msgs.length ? msgs.map(previewMessage).join('') : emptyBlock('没有解析出消息，请检查格式或角色标记。')}</div>
      <div class="loop-actions"><button class="loop-btn loop-btn-primary" type="button" data-loop-action="import">按当前角色修正导入</button></div>
    </div>`
  }

  function previewMessage(m) {
    const idx = Number(m.index || 0) || 0
    const rawRole = m.role || 'unknown'
    const current = state.roleOverrides[idx] || (ROLES.includes(rawRole) ? rawRole : 'unknown')
    const unknown = !ROLES.includes(rawRole) || current === 'unknown'
    const warns = Array.isArray(m.warnings) ? m.warnings : []
    return `<div class="loop-msg loop-msg-edit ${unknown ? 'is-unknown' : ''}">
      <span class="loop-msg-index">#${idx}</span>
      <select class="loop-role-select" data-role-index="${idx}" aria-label="修正第 ${idx} 条消息角色">${ROLES.map((r) => opt(r, ROLE_LABEL[r], current)).join('')}</select>
      <div class="loop-msg-body">
        <div class="loop-msg-content">${esc(m.content || '')}</div>
        ${unknown ? `<div class="loop-warn">无法识别角色「${esc(String(rawRole))}」，已按 unknown 处理；导入前可修正。</div>` : ''}
        ${warns.length ? `<div class="loop-warn">${warns.map((w) => esc(String(w))).join('；')}</div>` : ''}
        ${m.originalTime ? `<div class="loop-meta">原文时间：${esc(m.originalTime)}</div>` : ''}
      </div>
    </div>`
  }

  function importResultHtml() {
    const r = state.importResult
    if (!r) return ''
    const out = r.out || {}
    const src = out.source || {}
    const warns = Array.isArray(out.warnings) ? out.warnings : []
    return `<div class="loop-card">
      <div class="loop-card-title">导入结果</div>
      <div class="loop-kv">
        <span>重复文件</span><b>${out.duplicate ? '是（未重复创建）' : '否'}</b>
        <span>追加消息</span><b>${fmt(out.appended || 0)} 条</b>
        <span>来源状态</span><b>${esc(EXTRACT_STATUS[src.extraction_status] || src.extraction_status || '—')}</b>
        <span>附件</span><b>${fmt(out.attachment_count || 0)} 个（内容未解析）</b>
        ${out.batch_id ? `<span>批次</span><b>${esc(out.batch_id)}</b>` : ''}
      </div>
      ${warns.length ? `<div class="loop-warn">${warns.map((w) => esc(String(w))).join('<br>')}</div>` : ''}
      ${out.batch_id && src.id ? `<div class="loop-actions"><button class="loop-btn loop-btn-sm" type="button" data-loop-action="watch-batch" data-id="${esc(src.id)}">查看批次进度</button></div>` : ''}
    </div>`
  }

  function archiveResultHtml() {
    const r = state.archiveResult
    if (!r) return ''
    const a = r.archived || {}
    return `<div class="loop-card">
      <div class="loop-card-title">归档结果</div>
      <div class="loop-kv">
        <span>来源</span><b>${fmt(a.sources ?? 1)}</b>
        <span>受影响记忆</span><b>${fmt(a.memories ?? 0)}</b>
        <span>受影响规则</span><b>${fmt(a.rules ?? 0)}</b>
      </div>
      ${r.note ? `<div class="loop-hint">${esc(r.note)}</div>` : ''}
      <div class="loop-hint">失去唯一证据的记忆 / 规则已退出当前调用。</div>
    </div>`
  }

  function sourceListHtml() {
    if (!state.imports.length) return emptyBlock('还没有导入记录。选择文件或粘贴文本，预览后导入。')
    return `<div class="loop-list">${state.imports.map(sourceRow).join('')}</div>`
  }

  function sourceRow(s) {
    const msgs = Array.isArray(s.messages) ? s.messages.length : Number(s.messages || 0)
    const atts = Array.isArray(s.attachments) ? s.attachments.length : Number(s.attachments || s.attachment_count || 0)
    const batches = Array.isArray(s.batches) ? s.batches : []
    const latest = batches[0]
    const status = EXTRACT_STATUS[s.extraction_status] || s.extraction_status || '—'
    const failedBatch = batches.find((b) => ['failed', 'partial'].includes(b.status) || (b.status === 'done' && Number(b.failed) > 0))
    const derived = s.derived || {}
    return `<div class="loop-row loop-source">
      <div class="loop-source-main">
        <b>${esc(s.title || s.file_name || s.id)}</b>
        <div class="loop-meta">${esc(s.source_kind || 'text')} · ${esc(s.platform || '本机')} · ${esc(s.owner || 'local-user')}${s.project ? ` · 项目 ${esc(s.project)}` : ''}${s.task ? ` · 任务 ${esc(s.task)}` : ''}</div>
        <div class="loop-meta">${fmt(msgs)} 条消息 · 附件 ${fmt(atts)}（内容未解析） · ${esc(status)}${derived.memories != null ? ` · 记忆 ${fmt(derived.memories)} / 规则 ${fmt(derived.rules || 0)}` : ''}</div>
        ${latest ? `<div class="loop-meta">最近批次：${esc(BATCH_STATUS[latest.status] || latest.status)} · ${fmt(latest.done || 0)}/${fmt(latest.total || 0)}${Number(latest.failed) ? ` · 失败 ${fmt(latest.failed)}` : ''}</div>` : ''}
        ${failedBatch ? '<div class="loop-warn">有失败分块，可重试；已完成分块不会重复。</div>' : ''}
      </div>
      <div class="loop-actions loop-actions-col">
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="source-detail" data-id="${esc(s.id)}">详情</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="extract" data-id="${esc(s.id)}">重新拆解</button>
        ${failedBatch ? `<button class="loop-btn loop-btn-sm" type="button" data-loop-action="retry-batch" data-id="${esc(failedBatch.id)}" data-source-id="${esc(s.id)}">重试失败分块</button>` : ''}
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="archive-source" data-id="${esc(s.id)}">归档来源</button>
      </div>
    </div>`
  }

  function sourceDetailHtml() {
    const d = state.sourceDetail
    if (!d) return ''
    const head = `<div class="loop-card-title">来源详情 · ${esc(d.id)} <button class="loop-btn loop-btn-sm" type="button" data-loop-action="close-source-detail">关闭</button></div>`
    if (d.loading) return `<div class="loop-card">${head}${loadingBlock('正在读取来源详情…')}</div>`
    if (d.error) {
      return `<div class="loop-card">${head}${errorHtml(d.error)}<div class="loop-actions"><button class="loop-btn loop-btn-sm" type="button" data-loop-action="source-detail" data-id="${esc(d.id)}">重试</button></div></div>`
    }
    const data = d.data || {}
    const s = data.source || {}
    const messages = Array.isArray(data.messages) ? data.messages : []
    const batches = Array.isArray(data.batches) ? data.batches : []
    const derived = data.derived || {}
    const archived = state.archiveResult && state.archiveResult.sourceId === d.id ? state.archiveResult : null
    return `<div class="loop-card">
      ${head}
      <div class="loop-kv">
        <span>标题</span><b>${esc(s.title || '—')}</b>
        <span>归属</span><b>${esc(s.owner || 'local-user')}${s.project ? ` · 项目 ${esc(s.project)}` : ''}${s.task ? ` · 任务 ${esc(s.task)}` : ''}</b>
        <span>状态</span><b>${esc(EXTRACT_STATUS[s.extraction_status] || s.extraction_status || '—')}</b>
        <span>派生</span><b>记忆 ${fmt(derived.memories || 0)} · 规则 ${fmt(derived.rules || 0)}</b>
      </div>
      ${archived ? `<div class="loop-note">归档完成：来源 ${fmt(archived.archived?.sources ?? 0)} · 记忆 ${fmt(archived.archived?.memories ?? 0)} · 规则 ${fmt(archived.archived?.rules ?? 0)}${archived.note ? `。${esc(archived.note)}` : ''}</div>` : ''}
      ${batches.length ? `<div class="loop-section-title">批次</div>${batches.map(batchRow).join('')}` : ''}
      <div class="loop-section-title">消息原文 · ${fmt(messages.length)} 条</div>
      <div class="loop-list loop-msg-list">${messages.length ? messages.map(sourceMessageRow).join('') : emptyBlock('没有消息。')}</div>
      <div class="loop-actions">
        ${state.archiveConfirm === d.id
          ? `<span class="loop-warn">归档后，失去唯一证据的记忆 / 规则会退出当前调用。</span>
             <button class="loop-btn loop-btn-sm loop-btn-primary" type="button" data-loop-action="archive-source-confirm" data-id="${esc(d.id)}">确认归档</button>
             <button class="loop-btn loop-btn-sm" type="button" data-loop-action="archive-source-cancel">取消</button>`
          : `<button class="loop-btn loop-btn-sm" type="button" data-loop-action="archive-source" data-id="${esc(d.id)}">归档来源</button>`}
      </div>
    </div>`
  }

  function sourceMessageRow(m) {
    const atts = Array.isArray(m.attachments) ? m.attachments : []
    const warns = Array.isArray(m.warnings) ? m.warnings : []
    return `<div class="loop-source-msg">
      <div class="loop-memory-top">
        <span class="loop-role">${esc(ROLE_LABEL[m.role] || m.role || '未知')}</span>
        <span class="loop-meta">#${esc(String(m.ordinal ?? m.index ?? '—'))}${m.original_time ? ` · ${esc(m.original_time)}` : ''}</span>
      </div>
      <div class="loop-msg-content">${esc(m.content || '')}</div>
      ${atts.length ? `<div class="loop-meta">附件：${atts.map((a) => `${esc(a.name || '未命名')}（内容未解析）`).join('、')}</div>` : ''}
      ${warns.length ? `<div class="loop-warn">${warns.map((w) => esc(String(w))).join('；')}</div>` : ''}
    </div>`
  }

  async function refreshJobs() {
    try {
      const out = await api.loopJobs('?limit=20')
      state.jobs = out.items || []
      state.jobError = null
    } catch (e) { state.jobError = e }
  }

  function stopJobPoll() {
    if (jobTimer) { clearInterval(jobTimer); jobTimer = 0 }
    state.jobPollId = ''
  }

  function startJobPoll(jobId) {
    if (!jobId) return
    stopJobPoll()
    state.jobPollId = jobId
    const tick = async () => {
      try {
        const out = await api.loopJob(jobId)
        state.jobDetail = out.job
        state.jobError = null
        const el = bodyEl.querySelector('#loop-job-panel')
        if (el) el.innerHTML = jobPanelHtml()
        if (['done', 'partial', 'failed', 'cancelled'].includes(out.job.status)) {
          stopJobPoll()
          await refreshJobs()
          await refreshImports()
          await refreshOverview()
          if (state.view === 'import') render()
        }
      } catch (e) {
        state.jobError = e
        stopJobPoll()
        const el = bodyEl.querySelector('#loop-job-panel')
        if (el) el.innerHTML = jobPanelHtml()
      }
    }
    tick()
    jobTimer = setInterval(tick, 1000)
  }

  function jobStatusLabel(status) {
    return { queued: '排队中', running: '运行中', done: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消' }[status] || status || '—'
  }
  function jobTypeLabel(type) { return { extract: '拆解', embed: '向量化', import: '导入' }[type] || type }

  function jobPanelHtml() {
    const jobs = Array.isArray(state.jobs) ? state.jobs : []
    const detail = state.jobDetail
    const rows = jobs.map((j) => `<div class="loop-row">
      <div><b>${esc(jobTypeLabel(j.type))} · ${esc(jobStatusLabel(j.status))}</b>
        <div class="loop-meta">${esc(j.id)} · 进度 ${fmt(j.progress_done || 0)}/${fmt(j.progress_total || 0)} · 尝试 ${fmt(j.attempts || 0)}/${fmt(j.max_attempts || 0)}${j.source_id ? ` · 来源 ${esc(j.source_id)}` : ''}</div>
        ${j.error ? `<div class="loop-warn">${esc(j.error)}</div>` : ''}
      </div>
      <div class="loop-actions loop-actions-col">
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="job-poll" data-id="${esc(j.id)}">查看</button>
        ${['failed', 'partial', 'cancelled'].includes(j.status) ? `<button class="loop-btn loop-btn-sm" type="button" data-loop-action="job-retry" data-id="${esc(j.id)}">重试</button>` : ''}
        ${['queued', 'running'].includes(j.status) ? `<button class="loop-btn loop-btn-sm" type="button" data-loop-action="job-cancel" data-id="${esc(j.id)}">取消</button>` : ''}
      </div>
    </div>`).join('')
    const d = detail ? `<div class="loop-panel" style="margin-top:8px">
      <div class="loop-section-title">任务详情 · ${esc(detail.id)}</div>
      <div class="loop-meta">${esc(jobTypeLabel(detail.type))} · ${esc(jobStatusLabel(detail.status))} · 进度 ${fmt(detail.progress_done)}/${fmt(detail.progress_total)} · 尝试 ${fmt(detail.attempts)}/${fmt(detail.max_attempts)}${detail.lease_expired ? ' · 租约已过期（等待恢复）' : ''}</div>
      ${detail.error ? `<div class="loop-warn">${esc(detail.error)}</div>` : ''}
      ${detail.result?.chunks ? `<div class="loop-meta">分块：${detail.result.chunks.map((c) => `${esc(c.status)}${c.error ? `(${esc(c.error)})` : ''}`).join(' / ')}</div>` : ''}
      ${detail.result?.done != null && detail.type === 'embed' ? `<div class="loop-meta">向量：完成 ${fmt(detail.result.done)} · 跳过 ${fmt(detail.result.skipped)} · 失败 ${fmt(detail.result.failed)}</div>` : ''}
    </div>` : ''
    return `${rows ? `<div class="loop-list">${rows}</div>` : '<div class="loop-empty">没有后台任务。</div>'}${d}
      <div class="loop-actions"><button class="loop-btn loop-btn-sm" type="button" data-loop-action="jobs-refresh">刷新任务</button></div>${state.jobError ? errorHtml(state.jobError) : ''}`
  }

  function batchPanelHtml() {
    if (!state.batchSource && !state.batches.length && !state.batchesError && !Object.keys(state.extractResults).length) return ''
    const starting = !!state.extractStarting[state.batchSource]
    const extract = state.extractResults[state.batchSource]
    const extractErr = state.extractErrors[state.batchSource]
    return `<div class="loop-card">
      <div class="loop-card-title">拆解批次进度${state.batchSource ? ` · ${esc(state.batchSource)}` : ''}
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="batch-panel-close">收起</button></div>
      ${starting ? '<div class="loop-hint">已发起拆解请求（同步执行中），正在并行轮询 GET /batches …</div>' : ''}
      ${state.batchesError ? errorHtml(state.batchesError) : ''}
      ${extractErr ? errorHtml(extractErr) : ''}
      ${state.batches.length
        ? `<div class="loop-list">${state.batches.map(batchRow).join('')}</div>`
        : (starting ? loadingBlock('等待批次记录…') : emptyBlock('还没有批次记录。'))}
      ${extract ? `<div class="loop-section-title">上次拆解结果</div><div class="loop-kv">
        <span>新增记忆</span><b>${fmt(extract.memories_added || 0)}</b>
        <span>重复记忆</span><b>${fmt(extract.memories_duplicate || 0)}</b>
        <span>冲突</span><b>${fmt(extract.conflicts || 0)}</b>
        <span>新增规则</span><b>${fmt(extract.rules_added || 0)}</b>
        <span>候选结构</span><b>${fmt(extract.proposals || 0)}</b>
        <span>跳过保护</span><b>${fmt(extract.skipped_protected || 0)}</b>
        <span>失败分块</span><b>${fmt(extract.failed_chunks || 0)}</b>
      </div>` : ''}
    </div>`
  }

  function batchRow(b) {
    const total = Number(b.total || 0)
    const done = Number(b.done || 0)
    const failed = Number(b.failed || 0)
    const progress = b.progress != null ? Math.round(Number(b.progress) * 100) : (total ? Math.round((done / total) * 100) : 0)
    const pct = Math.max(0, Math.min(100, progress))
    const retry = ['failed', 'partial'].includes(b.status) || (b.status === 'done' && failed > 0)
    return `<div class="loop-batch">
      <div class="loop-memory-top">
        ${badge(BATCH_STATUS[b.status] || b.status, b.status)}
        <span class="loop-meta">${esc(b.kind || '')} · ${fmt(done)}/${fmt(total)}${failed ? ` · 失败 ${fmt(failed)}` : ''}</span>
        ${retry ? `<button class="loop-btn loop-btn-sm" type="button" data-loop-action="retry-batch" data-id="${esc(b.id)}" data-source-id="${esc(b.source_id || '')}">重试失败分块</button>` : ''}
      </div>
      <div class="loop-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
      ${b.error ? `<div class="loop-warn">${esc(String(b.error))}</div>` : ''}
    </div>`
  }

  /* ---------------------------------------------------------------- 记忆视图 */

  function memoryView() {
    const f = state.filters.memory
    return `
      <div class="loop-card">
        <div class="loop-card-title">筛选记忆</div>
        <div class="loop-toolbar loop-toolbar-wrap">
          <select data-filter="memory.type">${opt('', '全部类型', f.type)}${Object.entries(TYPE_LABEL).map(([k, v]) => opt(k, v, f.type)).join('')}</select>
          <select data-filter="memory.status">${opt('', '全部状态', f.status)}${Object.entries(STATUS_LABEL).map(([k, v]) => opt(k, v, f.status)).join('')}</select>
          <select data-filter="memory.scope_type">${opt('', '全部范围', f.scope_type)}${['global', 'project', 'task', 'object', 'user'].map((k) => opt(k, k, f.scope_type)).join('')}</select>
          <input data-filter="memory.source_id" value="${esc(f.source_id)}" placeholder="来源 ID">
          <input id="loop-mem-q" data-filter="memory.q" value="${esc(f.q)}" placeholder="搜索记忆文本">
          <button class="loop-btn" type="button" data-loop-action="memories">查询</button>
          <button class="loop-btn" type="button" data-loop-action="memories-clear">清空</button>
        </div>
        <div class="loop-actions">
          <button class="loop-btn loop-btn-sm" type="button" data-loop-action="mem-merge-panel">合并所选…</button>
          <span class="loop-meta">已选 <b id="loop-mem-selected">${state.memSelected.size}</b> 条</span>
          <span class="loop-hint">勾选 2 条以上，或在合并面板输入 ID。敏感记忆默认隐藏原文。</span>
        </div>
        ${mergePanelHtml()}
      </div>
      ${memoryDetailHtml()}
      ${sourceDetailHtml()}
      <div class="loop-list">${state.memories.length ? state.memories.map(memoryCard).join('') : emptyBlock('还没有原子记忆。先导入并拆解，或调整筛选条件。')}</div>`
  }

  function memoryCard(m) {
    const sensitive = !!m.sensitive
    const selected = state.memSelected.has(m.id)
    const editOpen = state.memEdit && state.memEdit.id === m.id
    const versionsOpen = !!state.memVersions[m.id]
    const ev = Array.isArray(m.evidence) ? m.evidence : []
    return `<article class="loop-memory" id="mem-${esc(m.id)}">
      <div class="loop-memory-top">
        <label class="loop-check"><input type="checkbox" data-mem-select="${esc(m.id)}"${selected ? ' checked' : ''} aria-label="选择记忆"> 选择</label>
        ${badge(TYPE_LABEL[m.type] || m.type, 'type')}
        ${badge(STATUS_LABEL[m.status] || m.status, m.status)}
        ${m.protected ? badge('人工保护', 'protected') : ''}
        ${sensitive ? badge('敏感 · 已隐藏', 'sensitive') : ''}
        ${m.version != null ? badge(`v${m.version}`, 'version') : ''}
        <span class="loop-meta">${esc(m.scope_type || '—')}/${esc(m.scope_id || 'all')} · 置信 ${Math.round(Number(m.certainty || 0) * 100)}%</span>
      </div>
      <div class="loop-memory-text">${sensitive ? '敏感 · 已隐藏' : esc(m.text || '')}</div>
      <div class="loop-meta">${m.ontology ? `本体：${esc(m.ontology.type_id || m.ontology.type || '')} / ${esc(m.ontology.name || '')}` : '未映射本体'} · ${esc(m.source_category || '—')} / ${esc(m.confirmation || '—')}</div>
      ${sensitive
        ? '<div class="loop-warn">敏感记忆原文与证据不在普通 UI 展示。</div>'
        : (ev.length ? `<details><summary>证据原文 ${ev.length} 条</summary>${ev.map((e) => `<button class="loop-quote loop-quote-btn" type="button" data-loop-action="memory-detail" data-id="${esc(m.id)}">“${esc(e.quote || '')}”</button>`).join('')}</details>` : '')}
      <div class="loop-actions">
        ${m.status !== 'confirmed' ? `<button class="loop-btn loop-btn-sm" type="button" data-loop-action="confirm-memory" data-id="${esc(m.id)}">确认</button>` : ''}
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="archive-memory" data-id="${esc(m.id)}">废弃</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="show-correct" data-id="${esc(m.id)}">纠正</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="mem-edit-open" data-id="${esc(m.id)}">编辑</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="mem-versions" data-id="${esc(m.id)}">版本历史</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="memory-detail" data-id="${esc(m.id)}">证据 / 来源</button>
      </div>
      <div class="loop-correct" id="correct-${esc(m.id)}" hidden>
        <textarea class="loop-correct-area" placeholder="输入纠正后的内容（会创建替代记录，旧记录保留）"></textarea>
        <div class="loop-actions"><button class="loop-btn loop-btn-sm loop-btn-primary" type="button" data-loop-action="correct-memory" data-id="${esc(m.id)}">保存纠正</button></div>
      </div>
      ${editOpen ? memoryEditPanel(m) : ''}
      ${versionsOpen ? memoryVersionsPanel(m, state.memVersions[m.id]) : ''}
    </article>`
  }

  function memoryEditPanel(m) {
    const objVal = typeof m.object_value === 'string'
      ? m.object_value
      : (m.object_value == null ? '' : JSON.stringify(m.object_value, null, 2))
    return `<div class="loop-panel">
      <div class="loop-section-title">编辑记忆 · 保存后 version+1 并标记人工保护</div>
      <label class="loop-field">规范化文本<textarea class="loop-textarea loop-textarea-sm" data-mem-text>${esc(m.text || '')}</textarea></label>
      <label class="loop-field">对象值 object_value（可留空）<textarea class="loop-textarea loop-textarea-sm" data-mem-object>${esc(objVal)}</textarea></label>
      <div class="loop-actions">
        <button class="loop-btn loop-btn-sm loop-btn-primary" type="button" data-loop-action="mem-edit-save" data-id="${esc(m.id)}">保存</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="mem-edit-cancel">取消</button>
      </div>
      <div class="loop-op-error" data-op-error="mem-edit:${esc(m.id)}"></div>
    </div>`
  }

  function memoryVersionsPanel(m, v) {
    const head = '<div class="loop-section-title">版本历史</div>'
    if (v.loading) return `<div class="loop-panel">${head}${loadingBlock('正在读取版本历史…')}</div>`
    if (v.error) {
      return `<div class="loop-panel">${head}${errorHtml(v.error)}<div class="loop-actions"><button class="loop-btn loop-btn-sm" type="button" data-loop-action="mem-versions" data-id="${esc(m.id)}">重试</button></div></div>`
    }
    const items = v.items || []
    return `<div class="loop-panel">${head}
      ${items.length ? `<div class="loop-list">${items.map((it) => `<div class="loop-row"><div>
        <b>v${esc(String(it.version))}</b> <span class="loop-meta">${esc(STATUS_LABEL[it.status] || it.status || '')} · ${esc(fmtTime(it.created_at))}</span>
        <div class="loop-msg-content">${m.sensitive ? '敏感 · 已隐藏' : esc(it.text || (it.object_value != null ? stringify(it.object_value) : ''))}</div>
        ${it.note ? `<div class="loop-meta">${esc(it.note)}</div>` : ''}
      </div></div>`).join('')}</div>` : emptyBlock('没有版本记录。')}
      <div class="loop-actions"><button class="loop-btn loop-btn-sm" type="button" data-loop-action="mem-versions-close">收起</button></div>
    </div>`
  }

  function mergePanelHtml() {
    if (!state.mergePanel) return ''
    const ids = [...state.memSelected]
    return `<div class="loop-panel">
      <div class="loop-section-title">合并记忆</div>
      <div class="loop-hint">已选 ${ids.length} 条；第一条作为合并目标。也可输入逗号分隔的记忆 ID 覆盖勾选。</div>
      <input class="loop-input" id="loop-merge-ids" value="${esc(state.mergeIds || ids.join(','))}" placeholder="memory-id-1, memory-id-2">
      <textarea class="loop-textarea loop-textarea-sm" id="loop-merge-text" placeholder="合并后的规范化文本（可留空）"></textarea>
      <div class="loop-actions">
        <button class="loop-btn loop-btn-sm loop-btn-primary" type="button" data-loop-action="mem-merge">合并</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="mem-merge-cancel">取消</button>
      </div>
      <div class="loop-op-error" data-op-error="mem-merge"></div>
    </div>`
  }

  function memoryDetailHtml() {
    const d = state.memDetail
    if (!d) return ''
    if (d.loading) return `<div class="loop-card">${loadingBlock('正在读取记忆详情…')}</div>`
    if (d.error) {
      return `<div class="loop-card">${errorHtml(d.error)}<div class="loop-actions"><button class="loop-btn loop-btn-sm" type="button" data-loop-action="memory-detail" data-id="${esc(d.id)}">重试</button><button class="loop-btn loop-btn-sm" type="button" data-loop-action="memory-detail-close">关闭</button></div></div>`
    }
    const data = d.data || {}
    const m = data.memory || {}
    const ev = Array.isArray(data.evidence) ? data.evidence : []
    return `<div class="loop-card">
      <div class="loop-card-title">记忆详情 · ${esc(m.id || '')} <button class="loop-btn loop-btn-sm" type="button" data-loop-action="memory-detail-close">关闭</button></div>
      <div class="loop-memory-text">${m.sensitive ? '敏感 · 已隐藏' : esc(m.text || '')}</div>
      <div class="loop-meta">${esc(TYPE_LABEL[m.type] || m.type || '')} · ${esc(STATUS_LABEL[m.status] || m.status || '')} · v${esc(String(m.version ?? '—'))} · ${esc(m.confirmation || '')}</div>
      <div class="loop-section-title">证据与来源</div>
      ${ev.length ? ev.map((e) => {
        const src = e.source || {}
        const msg = e.message || {}
        const srcId = src.id || e.source_id || msg.source_id || ''
        return `<div class="loop-evidence">
          <div class="loop-quote">“${esc(e.quote || msg.content || '')}”</div>
          ${msg.role || msg.content ? `<div class="loop-meta">消息：${esc(ROLE_LABEL[msg.role] || msg.role || '原文')}${msg.ordinal != null ? ` #${esc(String(msg.ordinal))}` : ''}${msg.content && msg.content !== e.quote ? ` · ${esc(String(msg.content).slice(0, 200))}` : ''}</div>` : ''}
          ${srcId ? `<button class="loop-btn loop-btn-sm" type="button" data-loop-action="open-source" data-id="${esc(srcId)}">来源：${esc(src.title || src.file_name || srcId)}</button>` : '<div class="loop-meta">来源已不可用</div>'}
        </div>`
      }).join('') : emptyBlock('这条记忆没有证据。')}
    </div>`
  }

  /* ---------------------------------------------------------------- 本体视图 */

  async function refreshOntologyVersions() {
    state.ontologyVersionLoading = true
    try {
      const out = await api.loopOntologyVersions()
      state.ontologyVersions = out.items || []
      state.ontologyVersionError = null
    } catch (e) { state.ontologyVersionError = e }
    finally { state.ontologyVersionLoading = false }
  }

  function ontologyVersionPanel() {
    const cur = state.ontology?.current_version
    const items = state.ontologyVersions || []
    const diff = state.ontologyVersionDiff
    const rb = state.ontologyRollback
    const diffList = (label, arr, render) => (arr && arr.length ? `<div class="loop-meta">${label}：${arr.map(render).join('；')}</div>` : '')
    return `<div class="loop-card">
      <div class="loop-card-title">结构版本历史 · 当前 v${esc(String(cur?.version ?? '—'))}${cur?.action ? `（${esc(cur.action)}）` : ''}</div>
      <div class="loop-actions"><button class="loop-btn loop-btn-sm" type="button" data-loop-action="ontology-versions-refresh">刷新版本</button><span class="loop-hint">旧版本不参与当前调用；回滚会生成新的版本记录。</span></div>
      ${state.ontologyVersionError ? errorHtml(state.ontologyVersionError) : ''}
      ${items.length ? `<div class="loop-list">${items.map((v) => `<div class="loop-row"><div>
        <b>v${esc(String(v.version))}</b> ${badge(v.action, v.action)} ${v.current ? badge('当前', 'active') : ''}
        <div class="loop-meta">${esc(fmtTime(v.created_at))} · ${esc(v.actor || 'local-user')}${v.note ? ` · ${esc(v.note)}` : ''}</div>
        <div class="loop-meta">新增 类型 ${v.summary.added.types} / 属性 ${v.summary.added.props} / 关系 ${v.summary.added.relations} · 删除 类型 ${v.summary.removed.types} / 属性 ${v.summary.removed.props} / 关系 ${v.summary.removed.relations}</div>
      </div><div class="loop-actions loop-actions-col">
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="ontology-version-diff" data-id="${esc(v.id)}">差异</button>
        ${v.current ? '' : `<button class="loop-btn loop-btn-sm" type="button" data-loop-action="ontology-version-rollback" data-id="${esc(v.id)}">回滚</button>`}
      </div></div>`).join('')}</div>` : '<div class="loop-meta">还没有结构版本。</div>'}
      ${diff ? `<div class="loop-panel"><div class="loop-section-title">差异 · v${esc(String(diff.version?.version ?? ''))}</div>
        ${diffList('新增类型', diff.diff.added?.types, (x) => esc(x.name || x.id))}
        ${diffList('删除类型', diff.diff.removed?.types, (x) => esc(x.name || x.id))}
        ${diffList('新增属性', diff.diff.added?.props, (x) => esc(x.key))}
        ${diffList('删除属性', diff.diff.removed?.props, (x) => esc(x.key))}
        ${diffList('新增关系', diff.diff.added?.relations, (x) => esc(x.name || x.id))}
        ${diffList('删除关系', diff.diff.removed?.relations, (x) => esc(x.name || x.id))}
        ${diffList('变更类型', diff.diff.changed?.types, (x) => esc(x.id))}
        <div class="loop-actions"><button class="loop-btn loop-btn-sm" type="button" data-loop-action="ontology-version-diff-close">收起差异</button></div>
      </div>` : ''}
      ${rb ? `<div class="loop-panel"><div class="loop-section-title">回滚影响评估</div>
        <div class="loop-kv">
          <span>删除类型</span><b>${fmt(rb.impact.summary.removed_types)}</b>
          <span>删除属性</span><b>${fmt(rb.impact.summary.removed_props)}</b>
          <span>删除关系</span><b>${fmt(rb.impact.summary.removed_relations)}</b>
          <span>受影响实例</span><b>${fmt(rb.impact.summary.instances)}</b>
          <span>受影响记忆</span><b>${fmt(rb.impact.summary.memories)}</b>
          <span>受影响规则</span><b>${fmt(rb.impact.summary.rules)}</b>
        </div>
        <div class="loop-hint">回滚不删除实例/记忆/规则；失去结构的实例标记 orphaned，引用失效结构的规则暂停。</div>
        <input class="loop-input" id="ont-rollback-note" value="${esc(rb.note || '')}" placeholder="回滚理由（写入审计）">
        <div class="loop-actions">
          <button class="loop-btn loop-btn-sm loop-btn-primary" type="button" data-loop-action="ontology-version-rollback-confirm" data-id="${esc(rb.id)}">确认回滚</button>
          <button class="loop-btn loop-btn-sm" type="button" data-loop-action="ontology-version-rollback-cancel">取消</button>
        </div>
      </div>` : ''}
    </div>`
  }

  function ontologyView() {
    const o = state.ontology || { types: [], relations: [], instances: [], proposals: [] }
    const types = Array.isArray(o.types) ? o.types : []
    const instances = Array.isArray(o.instances) ? o.instances : []
    const proposals = Array.isArray(o.proposals) ? o.proposals : []
    const relations = Array.isArray(o.relations) ? o.relations : []
    return `
      <div class="loop-actions">
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="ontology-refresh">刷新本体</button>
        <span class="loop-hint">定义与实例分区；结构候选发布后才会应用。</span>
      </div>
      <div class="loop-card">
        <div class="loop-card-title">本体定义 · ${fmt(types.length)} 个类型</div>
        ${types.length ? `<div class="loop-defs">${types.map(typeCard).join('')}</div>` : emptyBlock('暂无本体类型定义。')}
        ${relations.length ? `<div class="loop-section-title">关系定义</div><div class="loop-list">${relations.map((r) => `<div class="loop-row"><div><b>${esc(r.name || r.id)}</b><div class="loop-meta">${esc(r.from_type)} → ${esc(r.to_type)} · ${esc(r.id)}</div></div></div>`).join('')}</div>` : ''}
      </div>
      <div class="loop-card">
        <div class="loop-card-title">结构变更候选 · ${fmt(proposals.length)}</div>
        ${proposals.length ? `<div class="loop-list">${proposals.map(proposalRow).join('')}</div>` : emptyBlock('没有结构变更候选。')}
      </div>
      ${ontologyVersionPanel()}
      <div class="loop-card">
        <div class="loop-card-title">本体实例 · ${fmt(instances.length)}</div>
        ${instances.length ? `<div class="loop-list">${instances.map(instanceCard).join('')}</div>` : emptyBlock('还没有实例；拆解识别到对象后会生成候选。')}
      </div>`
  }

  function typeCard(t) {
    const props = Array.isArray(t.props) ? t.props : []
    const states = Array.isArray(t.states) ? t.states : []
    return `<div class="loop-def">
      <div class="loop-memory-top"><b>${esc(t.name || t.id)}</b>${badge(t.status || 'published', t.status || 'published')}<span class="loop-meta">${esc(t.id)} · v${esc(String(t.version ?? 1))}</span></div>
      ${t.description ? `<div class="loop-meta">${esc(t.description)}</div>` : ''}
      <div class="loop-meta">属性：${props.length ? props.map((p) => `${esc(p.name)}:${esc(p.datatype)}${p.unit ? `(${esc(p.unit)})` : ''}${p.required ? ' 必填' : ''}${Array.isArray(p.enum) && p.enum.length ? ` [${p.enum.map((e) => esc(String(e))).join('/')}]` : ''}`).join(' · ') : '无'}</div>
      <div class="loop-meta">状态：${states.length ? states.map((s) => `${esc(s.name)}${Array.isArray(s.transitions) && s.transitions.length ? ` → ${s.transitions.map((tr) => esc(Array.isArray(tr) ? tr[1] : tr)).join('/')}` : ''}`).join(' · ') : '无'}</div>
    </div>`
  }

  function proposalRow(p) {
    const res = state.opErrors[`proposal:${p.id}`]
    const applied = state.proposalResults[p.id]
    const appliedText = applied
      ? (applied.error ? `发布失败：${applied.error}` : `已发布：${applied.kind || '结构变更'} ${applied.id || ''}`)
      : ''
    return `<div class="loop-row">
      <div><b>${esc(p.kind || '结构候选')}</b><div class="loop-meta">${esc(stringify(p.payload))}</div>${p.status ? `<div class="loop-meta">状态：${esc(p.status)} · ${esc(fmtTime(p.created_at))}</div>` : ''}</div>
      <div class="loop-actions">${p.status && p.status !== 'candidate' ? badge(p.status, p.status) : `<button class="loop-btn loop-btn-sm loop-btn-primary" type="button" data-loop-action="proposal-approve" data-id="${esc(p.id)}">发布候选</button><button class="loop-btn loop-btn-sm" type="button" data-loop-action="proposal-reject" data-id="${esc(p.id)}">拒绝</button>`}</div>
      <div class="loop-op-error" data-op-error="proposal:${esc(p.id)}">${res ? errorHtml(res) : ''}</div>
      ${appliedText ? `<div class="loop-note">${esc(appliedText)}</div>` : ''}
    </div>`
  }

  function propLabel(p) {
    const name = p.name || p.prop_id || p.id || ''
    const val = p.value ?? p.prop_value ?? ''
    const unit = p.unit ? ` ${p.unit}` : ''
    return `${esc(String(name))}=${esc(stringify(val))}${esc(unit)}`
  }
  function relLabel(r) {
    return `${esc(r.name || r.relation_id || '关系')} → ${esc(r.to_name || r.to_instance_id || r.to || '—')}`
  }

  function instanceCard(i) {
    const d = state.instDetails[i.id]
    const open = !!d
    const data = d && d.data ? d.data : null
    const inst = (data && data.instance) || i
    const props = (data && data.properties) || inst.properties || []
    const rels = (data && data.relations) || inst.relations || []
    const type = (state.ontology?.types || []).find((t) => t.id === inst.type_id)
    const typeName = type?.name || inst.type_id
    return `<div class="loop-instance">
      <div class="loop-row">
        <div>
          <b>${esc(inst.name || inst.id)}</b>
          <span class="loop-meta">${esc(typeName)} · ${inst.candidate ? '候选' : '正式'} · 当前状态 ${esc(inst.current_state || '无')}</span>
          ${Array.isArray(inst.aliases) && inst.aliases.length ? `<div class="loop-meta">别名：${inst.aliases.map((a) => esc(String(a))).join('、')}</div>` : ''}
          <div class="loop-meta">属性：${props.length ? props.map(propLabel).join(' · ') : '未设置'}</div>
          ${rels.length ? `<div class="loop-meta">关系：${rels.map(relLabel).join(' · ')}</div>` : ''}
        </div>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="instance-open" data-id="${esc(i.id)}">${open ? '收起操作' : '展开 / 操作'}</button>
      </div>
      ${open ? instanceDetail(i, inst, type, data) : ''}
    </div>`
  }

  function stateOptions(type, current) {
    const states = Array.isArray(type && type.states) ? type.states : []
    const names = new Set(states.map((s) => s.name))
    const allowed = new Set()
    // 状态机可能把全部转换放在一条定义行里；收集所有 from/to，才能给出完整选项。
    for (const s of states) {
      for (const tr of Array.isArray(s.transitions) ? s.transitions : []) {
        if (!Array.isArray(tr)) continue
        if (tr[0]) names.add(tr[0])
        if (tr[1]) names.add(tr[1])
        if (tr[0] === current && tr[1]) allowed.add(tr[1])
      }
    }
    const list = [...names]
    return `<label>目标状态<select data-state-select>${list.length
      ? list.map((n) => `<option value="${esc(n)}">${esc(n)}${allowed.has(n) ? '（允许）' : ''}</option>`).join('')
      : '<option value="">无状态定义</option>'}</select></label>`
  }

  function instanceDetail(i, inst, type, data) {
    const d = state.instDetails[i.id] || {}
    if (d.loading) return `<div class="loop-panel">${loadingBlock('正在读取实例详情…')}</div>`
    if (d.error) {
      return `<div class="loop-panel">${errorHtml(d.error)}<div class="loop-actions"><button class="loop-btn loop-btn-sm" type="button" data-loop-action="instance-open" data-id="${esc(i.id)}">重试</button></div></div>`
    }
    const props = (data && data.properties) || inst.properties || []
    const rels = (data && data.relations) || inst.relations || []
    const history = (data && data.state_history) || inst.state_history || []
    const typeProps = Array.isArray(type && type.props) ? type.props : []
    const relations = (state.ontology?.relations || []).filter((r) => !r.from_type || r.from_type === inst.type_id || r.from_type === (type && type.name))
    const targets = (state.ontology?.instances || []).filter((x) => x.id !== inst.id)
    return `<div class="loop-panel">
      <div class="loop-section-title">属性</div>
      <div class="loop-kv">${props.length
        ? props.map((p) => `<span>${esc(p.name || p.prop_id || '')}</span><b>${esc(stringify(p.value ?? p.prop_value ?? ''))}${p.unit ? ` ${esc(p.unit)}` : ''}</b>`).join('')
        : '<span>—</span><b>未设置</b>'}</div>
      <div class="loop-subpanel">
        <div class="loop-section-title">设置属性</div>
        <div class="loop-grid loop-grid-3">
          <label>属性<select data-prop-select>${typeProps.length
            ? typeProps.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.unit ? ` (${esc(p.unit)})` : ''}</option>`).join('')
            : '<option value="">自定义属性</option>'}</select></label>
          <label>属性名（无定义时）<input data-prop-name placeholder="如 status"></label>
          <label>值<input data-prop-value placeholder="如 maintenance"></label>
          <label>单位<input data-prop-unit placeholder="如 t/d"></label>
        </div>
        <div class="loop-actions"><button class="loop-btn loop-btn-sm loop-btn-primary" type="button" data-loop-action="instance-prop" data-id="${esc(i.id)}">设置属性</button></div>
        <div class="loop-op-error" data-op-error="prop:${esc(i.id)}"></div>
      </div>
      <div class="loop-subpanel">
        <div class="loop-section-title">设置关系</div>
        <div class="loop-grid loop-grid-3">
          <label>关系<select data-rel-select>${relations.length
            ? relations.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}（${esc(r.from_type)} → ${esc(r.to_type)}）</option>`).join('')
            : '<option value="">自定义关系</option>'}</select></label>
          <label>关系名（无定义时）<input data-rel-name placeholder="如 belongs_to"></label>
          <label>目标实例<select data-rel-target><option value="">—</option>${targets.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}（${esc(x.type_id)}）</option>`).join('')}</select></label>
          <label>目标名称（无实例时）<input data-rel-to-name placeholder="实例名"></label>
        </div>
        <div class="loop-actions"><button class="loop-btn loop-btn-sm loop-btn-primary" type="button" data-loop-action="instance-relation" data-id="${esc(i.id)}">设置关系</button></div>
        <div class="loop-op-error" data-op-error="rel:${esc(i.id)}"></div>
      </div>
      <div class="loop-subpanel">
        <div class="loop-section-title">状态转换</div>
        <div class="loop-hint">当前：${esc(inst.current_state || '无')}；非法转换会被拒绝并保留当前状态。</div>
        <div class="loop-grid loop-grid-3">
          ${stateOptions(type, inst.current_state)}
          <label>原因<input data-state-reason placeholder="可选：转换原因"></label>
        </div>
        <div class="loop-actions"><button class="loop-btn loop-btn-sm loop-btn-primary" type="button" data-loop-action="instance-state" data-id="${esc(i.id)}">执行转换</button></div>
        <div class="loop-op-error" data-op-error="state:${esc(i.id)}"></div>
      </div>
      ${history.length ? `<div class="loop-section-title">状态历史</div><div class="loop-list">${history.map((h) => `<div class="loop-row"><div><b>${esc(h.from_state ? `${h.from_state} → ${h.to_state || h.state || ''}` : (h.state || h.to_state || ''))}</b><div class="loop-meta">${esc(fmtTime(h.created_at))}${h.reason ? ` · ${esc(h.reason)}` : ''}</div></div></div>`).join('')}</div>` : ''}
    </div>`
  }

  /* ---------------------------------------------------------------- 规则视图 */

  const REVIEW_FALLBACK = [{ id: 'auto', name: '全自动' }, { id: 'semi', name: '半自动' }, { id: 'manual', name: '手动' }]
  function reviewModeButtons() {
    const modes = state.reviewModes && state.reviewModes.length ? state.reviewModes : REVIEW_FALLBACK
    return modes.map((m) => `<button class="loop-btn loop-btn-sm ${state.reviewMode === m.id ? 'is-on' : ''}" type="button" data-loop-action="review-mode" data-id="${m.id}" title="${esc(m.description || '')}">${esc(m.name)}</button>`).join('')
  }
  function reviewModeHint() {
    const cur = (state.reviewModes || []).find((m) => m.id === state.reviewMode)
    if (!cur) return '规则默认候选；确认后才会进入上下文。编辑会写入版本并标记 human_edited。'
    return `当前「${cur.name}」：${cur.description}切换后对之后 AI 提炼的规则生效，已存在的候选不受影响。`
  }

  function rulesView() {
    const f = state.filters.rules
    const conflictMode = f.view === 'conflicts'
    return `
      <div class="loop-card">
        <div class="loop-card-title">规则视图</div>
        <div class="loop-toolbar loop-toolbar-wrap">
          ${Object.entries(RULE_VIEW).map(([k, v]) => `<button class="loop-btn loop-btn-sm ${f.view === k ? 'is-on' : ''}" type="button" data-loop-action="rules-view" data-id="${k}">${esc(v)}</button>`).join('')}
          <select data-filter="rules.status">${opt('', '全部状态', f.status)}${Object.entries(GOVERNANCE).map(([k, v]) => opt(k, v, f.status)).join('')}</select>
          <button class="loop-btn loop-btn-sm" type="button" data-loop-action="rules">刷新</button>
        </div>
        <div class="loop-toolbar loop-toolbar-wrap" style="margin-top:8px">
          <span class="loop-kv-key">规则审核模式</span>
          ${reviewModeButtons()}
        </div>
        <div class="loop-hint">${reviewModeHint()}</div>
      </div>
      ${conflictMode ? `<div class="loop-card"><div class="loop-card-title">冲突（GET /rules/conflicts）</div>${ruleConflictsHtml()}</div>` : ''}
      <div class="loop-list">${state.rules.length ? state.rules.map(ruleCard).join('') : emptyBlock(conflictMode ? '没有冲突规则。' : '还没有规则。导入对话并拆解，或在规则中心确认候选。')}</div>`
  }

  function ruleConflictsHtml() {
    if (state.ruleConflictsLoading) return loadingBlock('正在读取冲突…')
    if (state.ruleConflictsError) return errorHtml(state.ruleConflictsError)
    const items = state.ruleConflicts || []
    if (!items.length) return emptyBlock('没有检测到规则冲突。')
    return `<div class="loop-list">${items.map((c) => {
      const manualRes = c.manual || null
      const manual = !!c.adjudicated
      const resolvedLabel = manualRes ? (RESOLUTION[manualRes.resolution] || manualRes.resolution) : (c.resolution === 'unresolved' ? '未裁决' : `自动建议：${RESOLUTION[c.resolution] || c.resolution}`)
      return `<div class="loop-row loop-conflict">
        <div>
          <b>${esc(c.key || '冲突')}</b> ${badge(resolvedLabel, manual ? 'active' : 'conflict')}
          <div class="loop-meta">A: ${esc(c.a?.name || c.a?.id || '—')} · B: ${esc(c.b?.name || c.b?.id || '—')}</div>
          <div class="loop-meta">原因：${esc(c.reason || '—')}</div>
          ${manualRes && manualRes.note ? `<div class="loop-meta">人工理由：${esc(manualRes.note)}${manualRes.actor ? ` · ${esc(manualRes.actor)}` : ''}</div>` : ''}
          ${!manual ? '<div class="loop-warn">未人工裁决：冲突保留，不能当作已解决。</div>' : ''}
          <label class="loop-field">裁决理由<input class="loop-input" data-conflict-note="${esc(c.key)}" value="${esc(state.conflictNotes[c.key] || '')}" placeholder="写入审计的理由"></label>
          <div class="loop-actions">
            <button class="loop-btn loop-btn-sm" type="button" data-loop-action="resolve-conflict" data-id="${esc(c.key)}" data-resolution="prefer_a">选择 A</button>
            <button class="loop-btn loop-btn-sm" type="button" data-loop-action="resolve-conflict" data-id="${esc(c.key)}" data-resolution="prefer_b">选择 B</button>
            <button class="loop-btn loop-btn-sm" type="button" data-loop-action="resolve-conflict" data-id="${esc(c.key)}" data-resolution="keep_both">都保留</button>
            <button class="loop-btn loop-btn-sm" type="button" data-loop-action="resolve-conflict" data-id="${esc(c.key)}" data-resolution="disable_both">都暂停</button>
          </div>
          <div class="loop-op-error" data-op-error="conflict:${esc(c.key)}"></div>
        </div>
      </div>`
    }).join('')}</div>`
  }

  function ruleCard(r) {
    const gov = r.governance_status || 'candidate'
    const conflicts = Array.isArray(r.conflicts) ? r.conflicts : []
    const evidence = Array.isArray(r.evidence) ? r.evidence : []
    const sim = state.ruleSim[r.id]
    const versions = state.ruleVersions[r.id]
    const editOpen = state.ruleEdit && state.ruleEdit.id === r.id
    const supOpen = state.ruleSupersede && state.ruleSupersede.id === r.id
    const simOpen = state.ruleSimOpen === r.id
    return `<article class="loop-rule" id="rule-${esc(r.id)}">
      <div class="loop-memory-top">
        ${badge(r.categoryLabel || r.category || '规则')}
        ${badge(GOVERNANCE[gov] || gov, gov)}
        ${badge(STRENGTH[r.strength] || r.strength || '—', 'strength')}
        ${r.authority_label ? badge(`权限：${r.authority_label}`, 'authority') : ''}
        ${r.versions_count ? badge(`v${r.versions_count}`, 'version') : (r.version ? badge(`v${r.version}`, 'version') : '')}
        ${r.structure_status && r.structure_status !== 'structured' ? badge('待整理', 'unstructured') : ''}
        ${r.expired ? badge('已过期', 'expired') : ''}
        ${conflicts.length ? badge(`冲突 ${conflicts.length}`, 'conflict') : ''}
      </div>
      <div class="loop-memory-text">${esc(r.name || '未命名规则')}</div>
      <div class="loop-meta">${esc(r.description || '')}</div>
      <div class="loop-meta">有效期：${esc(r.valid_from || '—')} ~ ${esc(r.valid_to || '—')}${r.authority_rank != null ? ` · 权重 ${esc(String(r.authority_rank))}` : ''}</div>
      <div class="loop-rule-cond">条件 ${esc(stringify(r.conditions))}</div>
      <div class="loop-rule-cond">动作 ${esc(stringify(r.actions))}</div>
      ${conflicts.length ? `<div class="loop-warn">冲突：${conflicts.map((c) => esc(c.reason || c.key || stringify(c))).join('；')}</div>` : ''}
      ${Array.isArray(r.structure_errors) && r.structure_errors.length ? `<div class="loop-warn">待整理：${r.structure_errors.map(esc).join('；')}（不能自动执行，需人工整理条件）</div>` : ''}
      ${evidence.length ? `<details><summary>证据 ${evidence.length}</summary>${evidence.map((e) => `<div class="loop-quote">“${esc(e.quote || '')}”</div>`).join('')}</details>` : ''}
      <div class="loop-actions">
        ${['candidate', 'draft', 'proposed'].includes(gov) ? `<button class="loop-btn loop-btn-sm" type="button" data-loop-action="approve-rule" data-id="${esc(r.id)}">确认生效</button>` : ''}
        ${gov === 'active' ? `<button class="loop-btn loop-btn-sm" type="button" data-loop-action="pause-rule" data-id="${esc(r.id)}">暂停</button>` : ''}
        ${gov === 'paused' ? `<button class="loop-btn loop-btn-sm" type="button" data-loop-action="resume-rule" data-id="${esc(r.id)}">恢复</button>` : ''}
        ${gov !== 'archived' ? `<button class="loop-btn loop-btn-sm" type="button" data-loop-action="archive-rule" data-id="${esc(r.id)}">归档</button>` : ''}
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="show-sim" data-id="${esc(r.id)}">模拟评估</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="rule-versions" data-id="${esc(r.id)}">版本历史</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="rule-edit-open" data-id="${esc(r.id)}">编辑</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="rule-supersede-open" data-id="${esc(r.id)}">替代</button>
      </div>
      ${simOpen ? ruleSimPanel(r) : ''}
      ${sim && !simOpen ? ruleSimResult(sim) : ''}
      ${versions ? ruleVersionsPanel(r, versions) : ''}
      ${editOpen ? ruleEditPanel(r) : ''}
      ${supOpen ? ruleSupersedePanel(r) : ''}
    </article>`
  }

  function ruleSimPanel(r) {
    const st = state.ruleSim[r.id] || {}
    return `<div class="loop-sim" id="sim-${esc(r.id)}">
      <textarea class="loop-textarea loop-textarea-sm" id="sim-ctx-${esc(r.id)}" placeholder='测试上下文 JSON，例如 {"well":{"status":"maintenance"}}'>${esc(st.contextText || '')}</textarea>
      <div class="loop-actions">
        <button class="loop-btn loop-btn-sm loop-btn-primary" type="button" data-loop-action="simulate" data-id="${esc(r.id)}">评估</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="rule-sim-close" data-id="${esc(r.id)}">收起</button>
      </div>
      <div class="loop-op-error" data-op-error="sim:${esc(r.id)}">${st.error ? errorHtml(st.error) : ''}</div>
      ${st.out ? ruleSimResult(st) : ''}
    </div>`
  }

  function ruleSimResult(st) {
    const out = st.out || {}
    const result = out.result || 'unknown'
    const label = { applicable: '命中', not_applicable: '未命中', unknown: '无法判断' }[result] || result
    const conds = Array.isArray(out.conditions) ? out.conditions : []
    const isUnknown = (c) => c && (c.unknown === true || c.result === 'unknown')
    return `<div class="loop-sim-result">
      <div class="loop-sim-${esc(result)}">${esc(label)} · ${esc(out.reason || '')}</div>
      ${conds.length ? `<div class="loop-section-title">条件明细</div>${conds.map((c) => `<div class="loop-meta">${esc(c.label || '条件')}${c.path ? ` (${esc(String(c.path))})` : ''} → ${isUnknown(c) ? `unknown：${esc(c.reason || '缺少属性，不按满足处理')}` : `${c.result ? '满足' : '不满足'}${c.reason ? `：${esc(c.reason)}` : ''}`}</div>`).join('')}` : ''}
    </div>`
  }

  function ruleVersionsPanel(r, v) {
    const head = '<div class="loop-section-title">版本历史</div>'
    if (v.loading) return `<div class="loop-panel">${head}${loadingBlock('正在读取版本历史…')}</div>`
    if (v.error) {
      return `<div class="loop-panel">${head}${errorHtml(v.error)}<div class="loop-actions"><button class="loop-btn loop-btn-sm" type="button" data-loop-action="rule-versions" data-id="${esc(r.id)}">重试</button></div></div>`
    }
    const items = v.items || []
    return `<div class="loop-panel">${head}
      ${items.length ? `<div class="loop-list">${items.map((it) => `<div class="loop-row"><div>
        <b>v${esc(String(it.version))}</b> <span class="loop-meta">${esc(STATUS_LABEL[it.status] || it.status || '')} · ${esc(fmtTime(it.created_at))}</span>
        <div class="loop-meta">${esc(it.name || '')}${it.note ? ` · ${esc(it.note)}` : ''}</div>
      </div></div>`).join('')}</div>` : emptyBlock('没有版本记录。')}
      <div class="loop-actions"><button class="loop-btn loop-btn-sm" type="button" data-loop-action="rule-versions-close">收起</button></div>
    </div>`
  }

  function ruleEditPanel(r) {
    const draft = (state.ruleEdit && state.ruleEdit.draft) || {}
    const val = (k, fb) => esc(draft[k] != null ? String(draft[k]) : String(fb == null ? '' : fb))
    const jsonVal = (k, fb) => esc(draft[k] != null ? String(draft[k]) : stringifyPretty(fb, Array.isArray(fb) ? '[]' : '{}'))
    return `<div class="loop-panel">
      <div class="loop-section-title">编辑规则 · 保存后写入版本并标记 human_edited</div>
      <div class="loop-grid">
        <label>名称<input data-rule-field="name" value="${val('name', r.name)}"></label>
        <label>分类<input data-rule-field="category" value="${val('category', r.category)}"></label>
        <label>强度<select data-rule-field="strength">${Object.entries(STRENGTH).map(([k, v]) => opt(k, v, draft.strength != null ? draft.strength : r.strength)).join('')}</select></label>
        <label>范围类型<input data-rule-field="scope_type" value="${val('scope_type', r.scope_type)}"></label>
        <label>范围 ID<input data-rule-field="scope_id" value="${val('scope_id', r.scope_id)}"></label>
        <label>有效期起<input data-rule-field="valid_from" value="${val('valid_from', r.valid_from)}" placeholder="YYYY-MM-DD"></label>
        <label>有效期止<input data-rule-field="valid_to" value="${val('valid_to', r.valid_to)}" placeholder="YYYY-MM-DD"></label>
        <label>结构状态<select data-rule-field="structure_status">${opt('structured', '已结构化', draft.structure_status || r.structure_status)}${opt('unstructured', '待整理', draft.structure_status || r.structure_status)}</select></label>
        <label>说明<input data-rule-field="description" value="${val('description', r.description)}"></label>
      </div>
      <label class="loop-field">条件 JSON（保存前 JSON.parse 校验）<textarea class="loop-textarea loop-textarea-sm" data-rule-json="conditions">${jsonVal('conditions', r.conditions)}</textarea></label>
      <label class="loop-field">动作 JSON<textarea class="loop-textarea loop-textarea-sm" data-rule-json="actions">${jsonVal('actions', r.actions)}</textarea></label>
      <label class="loop-field">例外 JSON<textarea class="loop-textarea loop-textarea-sm" data-rule-json="exceptions">${jsonVal('exceptions', r.exceptions)}</textarea></label>
      <div class="loop-actions">
        <button class="loop-btn loop-btn-sm loop-btn-primary" type="button" data-loop-action="rule-edit-save" data-id="${esc(r.id)}">保存</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="rule-edit-cancel">取消</button>
      </div>
      <div class="loop-op-error" data-op-error="rule-edit:${esc(r.id)}"></div>
    </div>`
  }

  function ruleSupersedePanel(r) {
    const draft = (state.ruleSupersede && state.ruleSupersede.draft) || {}
    const val = (k, fb) => esc(draft[k] != null ? String(draft[k]) : String(fb == null ? '' : fb))
    const jsonVal = (k, fb) => esc(draft[k] != null ? String(draft[k]) : stringifyPretty(fb, Array.isArray(fb) ? '[]' : '{}'))
    return `<div class="loop-panel">
      <div class="loop-section-title">替代规则 · 新规则 supersedes_id = 旧 id，旧规则变为 superseded</div>
      <div class="loop-grid">
        <label>新名称<input data-supersede-field="name" value="${val('name', r.name)}"></label>
        <label>分类<input data-supersede-field="category" value="${val('category', r.category)}"></label>
        <label>强度<select data-supersede-field="strength">${Object.entries(STRENGTH).map(([k, v]) => opt(k, v, draft.strength != null ? draft.strength : r.strength)).join('')}</select></label>
        <label>说明<input data-supersede-field="description" value="${val('description', r.description)}"></label>
        <label>范围类型<input data-supersede-field="scope_type" value="${val('scope_type', r.scope_type)}"></label>
        <label>范围 ID<input data-supersede-field="scope_id" value="${val('scope_id', r.scope_id)}"></label>
        <label>有效期起<input data-supersede-field="valid_from" value="${val('valid_from', r.valid_from)}" placeholder="YYYY-MM-DD"></label>
        <label>有效期止<input data-supersede-field="valid_to" value="${val('valid_to', r.valid_to)}" placeholder="YYYY-MM-DD"></label>
      </div>
      <label class="loop-field">条件 JSON<textarea class="loop-textarea loop-textarea-sm" data-supersede-json="conditions">${jsonVal('conditions', r.conditions)}</textarea></label>
      <label class="loop-field">动作 JSON<textarea class="loop-textarea loop-textarea-sm" data-supersede-json="actions">${jsonVal('actions', r.actions)}</textarea></label>
      <label class="loop-check"><input type="checkbox" data-supersede-activate${draft.activate ? ' checked' : ''}> 创建后立即生效（activate；默认仍为候选）</label>
      <div class="loop-actions">
        <button class="loop-btn loop-btn-sm loop-btn-primary" type="button" data-loop-action="rule-supersede-save" data-id="${esc(r.id)}">创建替代规则</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="rule-supersede-cancel">取消</button>
      </div>
      <div class="loop-op-error" data-op-error="rule-supersede:${esc(r.id)}"></div>
    </div>`
  }

  /* ---------------------------------------------------------------- Skill 视图 */

  function skillsView() {
    const f = state.filters.skills
    const derive = state.skillDerive
    const derivedCount = derive ? (Array.isArray(derive.items) ? derive.items.length : (typeof derive.derived === 'number' ? derive.derived : 0)) : 0
    return `
      <div class="loop-card">
        <div class="loop-card-title">Skill 候选</div>
        <div class="loop-toolbar loop-toolbar-wrap">
          <select data-filter="skills.status">${opt('', '全部状态', f.status)}${Object.entries(SKILL_STATUS).map(([k, v]) => opt(k, v, f.status)).join('')}</select>
          <input data-f="skills.project" value="${esc(state.forms.skills.project)}" placeholder="项目（可留空）">
          <span class="loop-hint">最少记忆数</span>
          <input data-f="skills.min_memories" value="${esc(state.forms.skills.min_memories)}" placeholder="3" aria-label="最少方法记忆数" style="max-width:92px">
          <button class="loop-btn" type="button" data-loop-action="skills-derive">从 method 记忆生成候选</button>
          <button class="loop-btn loop-btn-sm" type="button" data-loop-action="skills-refresh">刷新</button>
        </div>
        ${derive ? `<div class="loop-note">已生成 ${fmt(derivedCount)} 个候选${derive.derived != null && typeof derive.derived === 'number' ? `（derived=${fmt(derive.derived)}）` : ''}</div>` : ''}
        <div class="loop-hint">从方法类记忆生成候选；导出得到 Markdown 并直接下载；忽略后不再出现在候选列表。</div>
      </div>
      <div class="loop-list">${state.skills.length ? state.skills.map(skillCard).join('') : emptyBlock('还没有 Skill 候选。可从 method 记忆生成。')}</div>`
  }

  function skillCard(s) {
    const editOpen = state.skillEdit && state.skillEdit.id === s.id
    const steps = Array.isArray(s.steps) ? s.steps : []
    const evidence = Array.isArray(s.evidence) ? s.evidence : []
    return `<article class="loop-rule">
      <div class="loop-memory-top">
        ${badge(SKILL_STATUS[s.status] || s.status || '候选', s.status || 'candidate')}
        ${s.version ? badge(`v${s.version}`, 'version') : ''}
        ${steps.length ? badge(`${steps.length} 步`) : ''}
      </div>
      <div class="loop-memory-text">${esc(s.name || '未命名 Skill')}</div>
      <div class="loop-meta">场景：${esc(s.scenario || '—')} · 输出：${esc(s.output_format || '—')}</div>
      ${Array.isArray(s.inputs) && s.inputs.length ? `<div class="loop-meta">输入：${s.inputs.map((x) => esc(String(x))).join('、')}</div>` : ''}
      ${evidence.length ? `<details><summary>证据 ${evidence.length}</summary>${evidence.map((e) => `<div class="loop-quote">“${esc(e.quote || '')}”</div>`).join('')}</details>` : ''}
      <div class="loop-actions">
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="skill-edit-open" data-id="${esc(s.id)}">编辑</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="skill-export" data-id="${esc(s.id)}">导出 Markdown</button>
        ${s.status !== 'rejected' ? `<button class="loop-btn loop-btn-sm" type="button" data-loop-action="skill-reject" data-id="${esc(s.id)}">忽略</button>` : ''}
      </div>
      ${editOpen ? skillEditPanel(s) : ''}
    </article>`
  }

  function skillEditPanel(s) {
    return `<div class="loop-panel">
      <div class="loop-section-title">编辑 Skill 候选</div>
      <div class="loop-grid">
        <label>名称<input data-skill-field="name" value="${esc(s.name || '')}"></label>
        <label>场景<input data-skill-field="scenario" value="${esc(s.scenario || '')}"></label>
        <label>输出格式<input data-skill-field="output_format" value="${esc(s.output_format || '')}"></label>
        <label>验收标准<input data-skill-field="acceptance" value="${esc(s.acceptance || '')}"></label>
      </div>
      ${['inputs', 'preconditions', 'exceptions', 'boundaries'].map((k) => `<label class="loop-field">${esc(SKILL_ARRAY_LABEL[k])} JSON<textarea class="loop-textarea loop-textarea-sm" data-skill-json="${k}">${esc(stringifyPretty(s[k] ?? [], '[]'))}</textarea></label>`).join('')}
      <label class="loop-field">步骤 JSON（[{order,text,memory_id}]）<textarea class="loop-textarea loop-textarea-sm" data-skill-json="steps">${esc(stringifyPretty(s.steps ?? [], '[]'))}</textarea></label>
      <div class="loop-actions">
        <button class="loop-btn loop-btn-sm loop-btn-primary" type="button" data-loop-action="skill-edit-save" data-id="${esc(s.id)}">保存</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="skill-edit-cancel">取消</button>
      </div>
      <div class="loop-op-error" data-op-error="skill-edit:${esc(s.id)}"></div>
    </div>`
  }

  /* ---------------------------------------------------------------- 上下文 / 反馈 */

  async function refreshVectorStatus(probe = false) {
    try {
      const out = await api.loopEmbeddingStatus(probe ? '?probe=1' : '')
      state.vectorStatus = out
      state.vectorError = null
    } catch (e) { state.vectorError = e }
  }

  function vectorPanelHtml() {
    const v = state.vectorStatus
    if (state.vectorError) return errorHtml(state.vectorError)
    if (!v) return loadingBlock('正在读取向量状态…')
    if (!v.configured) {
      return `<div class="loop-warn">向量未配置：上下文只使用词法/关联检索；不会伪造向量结果。</div>
        <div class="loop-meta">配置项：loopEmbedEndpoint / loopEmbedModel / loopEmbedApiKeyEnv</div>`
    }
    const c = v.counts || {}
    return `<div class="loop-kv">
      <span>模型</span><b>${esc(v.model)}</b>
      <span>端点</span><b>${esc(v.endpoint)}</b>
      <span>可探测</span><b>${v.available === true ? '是' : v.available === false ? '否' : '未探测'}</b>
      <span>已向量化</span><b>${fmt(c.embedded || 0)} / ${fmt(c.memories || 0)}</b>
      <span>过期</span><b>${fmt(c.stale || 0)}</b>
      <span>缺失</span><b>${fmt(c.missing || 0)}</b>
      <span>待处理任务</span><b>${fmt(c.pending_jobs || 0)}</b>
    </div>
    <div class="loop-hint">${esc(v.note || '')}${v.probe?.error ? ` · 探测错误：${esc(v.probe.error)}` : ''}</div>
    <div class="loop-actions">
      <button class="loop-btn loop-btn-sm" type="button" data-loop-action="vector-probe">探测服务</button>
      <button class="loop-btn loop-btn-sm loop-btn-primary" type="button" data-loop-action="vector-reindex">重建向量索引</button>
      <button class="loop-btn loop-btn-sm" type="button" data-loop-action="vector-refresh">刷新状态</button>
    </div>
    ${state.vectorJob ? `<div class="loop-note">已入队 ${esc(state.vectorJob.id)}（${esc(state.vectorJob.status)}）</div>` : ''}`
  }

  function contextView() {
    const f = state.forms.context
    return `
      <div class="loop-card">
        <div class="loop-card-title">组装当前上下文</div>
        <div class="loop-grid">
          <label>用户<input data-f="context.owner" value="${esc(f.owner)}"></label>
          <label>项目<input data-f="context.project" value="${esc(f.project)}" placeholder="可留空"></label>
          <label>任务<input data-f="context.task" value="${esc(f.task)}" placeholder="可留空"></label>
          <label>当前指令<input data-f="context.instruction" value="${esc(f.instruction)}" placeholder="可留空"></label>
          <label>检索关键词<input data-f="context.query" value="${esc(f.query)}" placeholder="用于关键词/关联重排，可留空"></label>
          <label>字符预算<input data-f="context.budget" value="${esc(f.budget)}" placeholder="默认使用服务端预算"></label>
          <label class="loop-check"><input type="checkbox" data-f="context.includeSensitive"${f.includeSensitive ? ' checked' : ''}> 包含敏感内容</label>
        </div>
        <textarea id="ctx-object" class="loop-textarea loop-textarea-sm" data-f="context.object" placeholder='业务对象 / 状态 JSON，例如 {"object":{"name":"WELL_001"},"well":{"status":"maintenance"}}'>${esc(f.object)}</textarea>
        <div class="loop-actions"><button class="loop-btn loop-btn-primary" type="button" data-loop-action="context">生成上下文</button></div>
        <div class="loop-op-error" data-op-error="context">${state.contextError ? errorHtml(state.contextError) : ''}</div>
      </div>
      <div id="ctx-result">${contextResultHtml()}</div>
      <div class="loop-card"><div class="loop-card-title">向量召回</div>${vectorPanelHtml()}</div>
      <div class="loop-card"><div class="loop-card-title">动作权限校验（只校验，不执行）</div>${actionCheckHtml()}</div>
      <div class="loop-card"><div class="loop-card-title">最近动作校验</div>${actionHistoryHtml()}</div>
      <div class="loop-card"><div class="loop-card-title">反馈</div>${feedbackForm()}</div>
      <div class="loop-card"><div class="loop-card-title">最近调用</div>${runsHtml()}</div>
      <div class="loop-card"><div class="loop-card-title">最近反馈</div>${feedbackListHtml()}</div>`
  }

  function contextResultHtml() {
    const out = state.contextResult
    if (!out) return ''
    const s = out.sections || {}
    return `<div class="loop-card">
      <div class="loop-card-title">上下文结果 · run ${esc(out.run_id || '—')}</div>
      <div class="loop-meta">用量 ${fmt(out.usage || 0)} / 预算 ${fmt(out.budget || 0)} 字符 · 优先级 ${esc(out.precedence || '—')}</div>
      ${ctxSection('任务背景', s.task_background)}
      ${ctxSection('当前指令', s.instruction)}
      ${ctxSection('必须遵守', s.rules)}
      ${actionsHtml(s.actions)}
      ${ctxSection('事实（已确认）', s.facts)}
      ${ctxSection('偏好 / 约束', [...toArray(s.preferences), ...toArray(s.constraints)])}
      ${ctxSection('建议候选（未确认）', s.suggestions)}
      ${ctxSection('未知 / 冲突', [...toArray(s.unknowns), ...toArray(s.conflicts)])}
      ${ctxSection('业务对象', s.objects)}
      ${ctxSection('待办', s.todos)}
      ${ctxSection('引用', s.citations)}
      ${ctxSection('过滤统计', s.filtered)}
      ${retrievalHtml(s.retrieval)}
    </div>`
  }

  function ctxSection(title, payload) {
    const items = asItems(payload)
    return `<div class="loop-ctx-section"><b>${esc(title)}</b>
      ${items.length ? items.map((x) => {
        const why = x && typeof x === 'object' ? (x.why || x.reason || '') : ''
        const ev = x && typeof x === 'object' && Array.isArray(x.evidence) ? x.evidence.map((e) => e && e.quote).filter(Boolean).join(' / ') : ''
        const strength = x && typeof x === 'object' && x.strength ? `[${STRENGTH[x.strength] || x.strength}] ` : ''
        const status = x && typeof x === 'object' && x.status ? `状态：${STATUS_LABEL[x.status] || x.status}` : ''
        const extra = [
          why ? `为什么：${why}` : '',
          ev ? `证据：${ev}` : '',
          status,
        ].filter(Boolean).join(' · ')
        return `<div class="loop-ctx-item"><div>${esc(strength + itemText(x))}</div>${extra ? `<div class="loop-meta">${esc(extra)}</div>` : ''}</div>`
      }).join('') : '<div class="loop-meta">无</div>'}
    </div>`
  }

  function actionsHtml(actions) {
    const items = Array.isArray(actions) ? actions : []
    return `<div class="loop-ctx-section"><b>动作（需单独授权）</b>
      ${items.length ? items.map((a) => `<div class="loop-ctx-item">
        <div>${a.execution === 'blocked' ? '禁止' : '需授权'} · ${esc(a.rule_name || '')} · ${esc(JSON.stringify(a.action))}</div>
        <div class="loop-meta">${esc(a.note || '')}</div>
      </div>`).join('') : '<div class="loop-meta">无</div>'}
    </div>`
  }

  function retrievalHtml(r) {
    if (!r) return ''
    const top = Array.isArray(r.top) ? r.top : []
    const v = r.vector || {}
    return `<div class="loop-ctx-section"><b>检索诊断</b>
      <div class="loop-meta">关键词：${esc((r.tokens || []).join(' / ') || '（无，按范围/时近）')} · 候选 ${fmt(r.candidate_count || 0)} · 选中 ${fmt(r.selected_count || 0)} · 硬约束 ${fmt(r.hard_kept || 0)} · 关联扩展 ${fmt(r.expanded || 0)}${r.truncated ? ' · 已截断' : ''}</div>
      <div class="loop-meta">向量：${v.configured ? (v.used ? `已使用 · ${esc(v.model)} · ${fmt(v.matched || 0)} 条相似` : `已配置但未使用${v.error ? ` · ${esc(v.error)}` : ''}`) : '未配置（仅词法）'}</div>
      ${top.slice(0, 8).map((t) => `<div class="loop-ctx-item"><div>${esc(t.text || t.memory_id)}</div><div class="loop-meta">分 ${esc(String(t.score))}${Array.isArray(t.matched) && t.matched.length ? ` · 命中 ${esc(t.matched.join(' / '))}` : ''}</div></div>`).join('')}
    </div>`
  }

  function actionCheckHtml() {
    const f = state.forms.action || {}
    const r = state.actionResult
    const resultLabel = {
      blocked: '被禁止', pending_authorization: '待授权', denied: '拒绝',
      authorized_not_executed: '已授权但未执行', no_applicable_action: '无适用动作',
    }
    return `
      <div class="loop-grid">
        <label>动作类型<select data-f="action.type">${opt('execute', '执行 execute', f.type)}${opt('start', '启动 start', f.type)}${opt('run', '运行 run', f.type)}${opt('other', '其他', f.type)}</select></label>
        <label>动作目标 target<input data-f="action.target" value="${esc(f.target || '')}" placeholder="如 parameter_optimization"></label>
        <label>授权备注<input data-f="action.note" value="${esc(f.note || '')}" placeholder="可选：授权依据"></label>
        <div class="loop-hint">本页只做动作模拟；实际执行授权由 DSH 工具审批完成。</div>
      </div>
      <div class="loop-actions">
        <button class="loop-btn loop-btn-primary" type="button" data-loop-action="action-check">校验动作权限</button>
        <button class="loop-btn" type="button" data-loop-action="action-refresh">刷新记录</button>
      </div>
      <div class="loop-op-error" data-op-error="action"></div>
      <div class="loop-hint">规则生效 ≠ 获准执行；禁止动作不能被授权绕过；无权限规则时拒绝；本机未连接外部执行器，校验通过也不会执行。</div>
      ${r ? `<div class="loop-panel loop-action-result">
        <div class="loop-section-title">校验结果：${esc(resultLabel[r.result] || r.result)} · executed=${r.executed ? '是' : '否'}</div>
        <div class="loop-meta">check ${esc(r.check_id || '—')} · ${r.authorized ? '已明确授权' : '未授权'} · run ${esc(r.context_run_id || '—')}</div>
        ${(r.items || []).map((i) => `<div class="loop-ctx-item">
          <div><b>${esc(resultLabel[i.result] || i.result)}</b> · ${esc(i.rule_name || '—')} · ${esc(JSON.stringify(i.action))}</div>
          <div class="loop-meta">${esc(i.reason || '')}${i.permission_rule_id ? ` · 权限规则 ${esc(i.permission_rule_id)}` : ''}</div>
        </div>`).join('')}
        <div class="loop-hint">${esc(r.note || '')}</div>
      </div>` : ''}`
  }

  function actionHistoryHtml() {
    if (!state.actions.length) return emptyBlock('还没有动作校验记录。')
    return `<div class="loop-list">${state.actions.slice(0, 6).map((a) => `<div class="loop-row"><div>
      <b>${esc(a.result || '—')}</b>${a.authorization ? ` · ${esc(a.authorization)}` : ''}
      <div class="loop-meta">${esc(fmtTime(a.created_at))} · 规则 ${fmt((a.rule_ids || []).length)} 条 · executed=${a.detail?.executed ? '是' : '否'}</div>
      ${a.reason ? `<div class="loop-meta">${esc(a.reason)}</div>` : ''}
    </div></div>`).join('')}</div>`
  }

  function feedbackForm() {
    const f = state.forms.feedback
    const rules = state.rules || []
    return `
      <div class="loop-grid">
        <label>outcome<select data-f="feedback.outcome">${Object.entries(OUTCOME).map(([k, v]) => opt(k, v, f.outcome)).join('')}</select></label>
        <label>category<select data-f="feedback.category"><option value="">（不指定）</option>${Object.entries(CATEGORY).map(([k, v]) => opt(k, v, f.category)).join('')}</select></label>
        <label>关联调用 run_id<input data-f="feedback.run_id" value="${esc(f.run_id)}" placeholder="可选"></label>
        <label>关联规则 rule_id<select data-f="feedback.rule_id"><option value="">（不指定）</option>${rules.map((r) => opt(r.id, r.name || r.id, f.rule_id)).join('')}</select></label>
        <label>关联记忆 memory_id<input data-f="feedback.memory_id" value="${esc(f.memory_id)}" placeholder="可选"></label>
        <label>纠正文本 correction<textarea class="loop-textarea loop-textarea-sm" data-f="feedback.correction" placeholder="state + correction 会生成纠正记忆">${esc(f.correction)}</textarea></label>
      </div>
      <label class="loop-field">反馈文本<textarea class="loop-textarea loop-textarea-sm" data-f="feedback.feedback" placeholder="发生了什么、期望如何修正">${esc(f.feedback)}</textarea></label>
      <div class="loop-actions"><button class="loop-btn loop-btn-primary" type="button" data-loop-action="feedback-submit">提交反馈</button></div>
      ${state.feedbackResult ? feedbackResultHtml(state.feedbackResult) : ''}
      <div class="loop-op-error" data-op-error="feedback"></div>`
  }

  function feedbackResultHtml(out) {
    const applied = out.applied
    let appliedText = '已记录；未自动修改记忆 / 规则。'
    if (applied) {
      const kindLabel = {
        rule: '候选规则版本', rule_version: '候选规则版本', rule_candidate: '候选规则版本',
        memory: '纠正记忆', memory_version: '纠正记忆', memory_correction: '纠正记忆',
      }[applied.kind] || applied.kind || '结果'
      appliedText = `已应用：${kindLabel}${applied.id ? ` ${applied.id}` : ''}${applied.supersedes_id ? `（替代 ${applied.supersedes_id}）` : ''}（默认不生效，需人工确认）`
    }
    return `<div class="loop-note">反馈已提交${out.id ? ` · ${esc(out.id)}` : ''}。${esc(appliedText)}${out.note ? `<br>${esc(out.note)}` : ''}</div>`
  }

  function runsHtml() {
    if (!state.runs.length) return emptyBlock('还没有调用记录。')
    return `<div class="loop-list">${state.runs.slice(0, 10).map((r) => `<div class="loop-row">
      <div><b>${esc(r.id)}</b><div class="loop-meta">${esc(fmtTime(r.created_at))} · ${esc(r.status || 'ok')} · ${fmt(r.budget || 0)} 字符预算</div></div>
      <div class="loop-actions">
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="feedback-quick" data-id="${esc(r.id)}" data-outcome="useful">有用</button>
        <button class="loop-btn loop-btn-sm" type="button" data-loop-action="feedback-quick" data-id="${esc(r.id)}" data-outcome="problem">有问题</button>
      </div>
    </div>`).join('')}</div>`
  }

  function feedbackListHtml() {
    if (!state.feedbacks.length) return emptyBlock('还没有反馈记录。')
    return `<div class="loop-list">${state.feedbacks.slice(0, 10).map((f) => `<div class="loop-row"><div>
      <b>${esc(OUTCOME[f.outcome] || f.outcome || '反馈')}</b>${f.category ? ` · ${esc(CATEGORY[f.category] || f.category)}` : ''}
      <div class="loop-meta">${esc(fmtTime(f.created_at))}${f.rule_id ? ` · 规则 ${esc(f.rule_id)}` : ''}${f.memory_id ? ` · 记忆 ${esc(f.memory_id)}` : ''}</div>
      ${f.feedback ? `<div class="loop-meta">${esc(f.feedback)}</div>` : ''}
    </div></div>`).join('')}</div>`
  }

  /* ---------------------------------------------------------------- 图谱 */

  function graphView() {
    const g = state.graph || { nodes: [], edges: [], counts: {} }
    const nodesAll = Array.isArray(g.nodes) ? g.nodes : []
    const edgesAll = Array.isArray(g.edges) ? g.edges : []
    const pageSize = 60
    const page = Math.max(0, Math.min(state.graphPage || 0, Math.max(0, Math.ceil(nodesAll.length / pageSize) - 1)))
    const start = page * pageSize
    const nodes = nodesAll.slice(start, start + pageSize)
    const ids = new Set(nodes.map((n) => String(n.id)))
    const edges = edgesAll.filter((e) => ids.has(String(e.src)) && ids.has(String(e.dst)))
    const layoutKey = `${page}:${nodesAll.length}:${edgesAll.length}`
    if (!state.graphLayout || state.graphLayoutKey !== layoutKey) {
      state.graphLayout = layoutGraph(nodes, edges)
      state.graphLayoutKey = layoutKey
    }
    const selected = state.graphSelected ? nodes.find((n) => String(n.id) === String(state.graphSelected)) : null
    const canProject = typeof window.__MB_SET_GRAPH__ === 'function'
    const counts = g.counts || {}
    const total = Number(counts.nodes ?? nodesAll.length)
    const pages = Math.max(1, Math.ceil(nodesAll.length / pageSize))
    return `
      <div class="loop-card">
        <div class="loop-card-title">记忆图谱</div>
        <div class="loop-toolbar loop-toolbar-wrap">
          <input data-filter="graph.owner" value="${esc(state.filters.graph.owner)}" placeholder="owner">
          <input data-filter="graph.project" value="${esc(state.filters.graph.project)}" placeholder="项目（可留空）">
          <button class="loop-btn loop-btn-sm" type="button" data-loop-action="graph-refresh">刷新</button>
          <button class="loop-btn loop-btn-sm ${state.graphProjection === 'loop' ? 'is-on' : ''}" type="button" data-loop-action="graph-projection"${canProject ? '' : ' disabled aria-disabled="true"'}>投射到中央大脑：${state.graphProjection === 'loop' ? '开' : '关'}</button>
        </div>
        <div class="loop-meta">节点 ${fmt(nodesAll.length)} / 服务端统计 ${fmt(total)} · 当前页 ${fmt(nodes.length)} 个 · 边 ${fmt(edges.length)}${total > nodesAll.length ? ` · 已达到接口上限 ${fmt(nodesAll.length)}，可用 owner / project 筛选` : ''}</div>
        ${canProject
          ? '<div class="loop-hint">开关调用 window.__MB_SET_GRAPH__(\'loop\' | \'base\')，切换中央三维大脑的数据源。</div>'
          : '<div class="loop-warn">当前页面未提供 window.__MB_SET_GRAPH__，投射开关已禁用（需要 app.js 暴露该接口）。</div>'}
        ${state.graphError ? errorHtml(state.graphError) : ''}
        ${nodes.length ? graphSvg(nodes, edges) : emptyBlock('图谱为空。先导入并拆解，或调整筛选。')}
        <div class="loop-actions">
          <button class="loop-btn loop-btn-sm" type="button" data-loop-action="graph-prev"${page <= 0 ? ' disabled' : ''}>上一页</button>
          <span class="loop-meta">第 ${page + 1} / ${pages} 页</span>
          <button class="loop-btn loop-btn-sm" type="button" data-loop-action="graph-next"${(page + 1) * pageSize >= nodesAll.length ? ' disabled' : ''}>下一页</button>
        </div>
      </div>
      ${selected ? graphNodeCard(selected) : ''}`
  }

  function graphNodeCard(n) {
    const sensitive = !!(n.meta && n.meta.sensitive)
    return `<div class="loop-card loop-graph-card">
      <div class="loop-card-title">节点详情 <button class="loop-btn loop-btn-sm" type="button" data-loop-action="graph-node-close">关闭</button></div>
      <div class="loop-kv">
        <span>名称</span><b>${sensitive ? '敏感 · 已隐藏' : esc(n.name || n.label || '—')}</b>
        <span>ID</span><b>${esc(n.id)}</b>
        <span>类型</span><b>${esc(GRAPH_TYPE[n.type] || n.type || '—')}</b>
        ${n.subtype ? `<span>子类型</span><b>${esc(n.subtype)}</b>` : ''}
        ${n.degree != null ? `<span>度</span><b>${esc(String(n.degree))}</b>` : ''}
      </div>
      <div class="loop-section-title">meta</div>
      <pre class="loop-pre">${sensitive ? '敏感内容已隐藏' : esc(stringifyPretty(n.meta ?? {}))}</pre>
    </div>`
  }

  function layoutGraph(nodes, edges) {
    const W = 820
    const H = 520
    const cx = W / 2
    const cy = H / 2
    const positions = new Map()
    const n = nodes.length || 1
    nodes.forEach((nd, i) => {
      const angle = (i / n) * Math.PI * 2
      const ring = 90 + (i % 5) * 24
      positions.set(String(nd.id), { x: cx + Math.cos(angle) * ring, y: cy + Math.sin(angle) * ring, vx: 0, vy: 0 })
    })
    const springs = edges
      .map((e) => [positions.get(String(e.src)), positions.get(String(e.dst))])
      .filter(([a, b]) => a && b)
    const k = Math.sqrt((W * H) / n) * 0.5
    const iterations = nodes.length > 90 ? 80 : 130
    for (let step = 0; step < iterations; step++) {
      const pts = [...positions.values()]
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i]
          const b = pts[j]
          let dx = a.x - b.x
          let dy = a.y - b.y
          let d2 = dx * dx + dy * dy
          if (d2 < 1) {
            dx = ((i * 13 + j * 7) % 10 - 5) / 5
            dy = ((i * 7 + j * 11) % 10 - 5) / 5
            d2 = dx * dx + dy * dy || 1
          }
          const d = Math.sqrt(d2)
          const force = (k * k) / d2
          a.vx += (dx / d) * force
          a.vy += (dy / d) * force
          b.vx -= (dx / d) * force
          b.vy -= (dy / d) * force
        }
      }
      for (const [a, b] of springs) {
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        const force = (d - k * 0.9) * 0.02
        a.vx += (dx / d) * force
        a.vy += (dy / d) * force
        b.vx -= (dx / d) * force
        b.vy -= (dy / d) * force
      }
      for (const p of positions.values()) {
        p.vx += (cx - p.x) * 0.002
        p.vy += (cy - p.y) * 0.002
        p.vx *= 0.82
        p.vy *= 0.82
        p.x += Math.max(-12, Math.min(12, p.vx))
        p.y += Math.max(-12, Math.min(12, p.vy))
      }
    }
    const pts = [...positions.values()]
    const minX = Math.min(...pts.map((p) => p.x))
    const maxX = Math.max(...pts.map((p) => p.x))
    const minY = Math.min(...pts.map((p) => p.y))
    const maxY = Math.max(...pts.map((p) => p.y))
    const spanX = Math.max(1, maxX - minX)
    const spanY = Math.max(1, maxY - minY)
    const pad = 36
    for (const p of positions.values()) {
      p.x = pad + ((p.x - minX) / spanX) * (W - pad * 2)
      p.y = pad + ((p.y - minY) / spanY) * (H - pad * 2)
    }
    return positions
  }

  function graphSvg(nodes, edges) {
    const layout = state.graphLayout || new Map()
    const degrees = new Map()
    for (const e of edges) {
      degrees.set(String(e.src), (degrees.get(String(e.src)) || 0) + 1)
      degrees.set(String(e.dst), (degrees.get(String(e.dst)) || 0) + 1)
    }
    const maxDeg = Math.max(1, ...degrees.values())
    const rOf = (node) => 4 + Math.min(9, ((degrees.get(String(node.id)) || 0) / maxDeg) * 9)
    const labelEdges = edges.length <= 90
    const edgeSvg = edges.map((e) => {
      const a = layout.get(String(e.src))
      const b = layout.get(String(e.dst))
      if (!a || !b) return ''
      const kind = e.kind || e.label || ''
      const mx = ((a.x + b.x) / 2).toFixed(1)
      const my = ((a.y + b.y) / 2).toFixed(1)
      return `<g class="loop-edge"><line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"></line>${labelEdges && kind ? `<text x="${mx}" y="${my}" class="loop-edge-label">${esc(kind)}</text>` : `<title>${esc(kind)}</title>`}</g>`
    }).join('')
    const nodeSvg = nodes.map((node) => {
      const p = layout.get(String(node.id))
      if (!p) return ''
      const type = ['memory', 'object', 'rule'].includes(node.type) ? node.type : 'memory'
      const selected = String(state.graphSelected) === String(node.id)
      const r = rOf(node)
      const sensitive = !!(node.meta && node.meta.sensitive)
      const label = sensitive ? '敏感 · 已隐藏' : String(node.name || node.label || node.id)
      return `<g class="loop-node loop-node-${esc(type)}${selected ? ' is-selected' : ''}" data-node-id="${esc(node.id)}" role="button" tabindex="0" aria-label="${esc(label)}" transform="translate(0,0)">
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}"></circle>
        <text x="${p.x.toFixed(1)}" y="${(p.y - r - 4).toFixed(1)}" text-anchor="middle">${esc(label.slice(0, 18))}</text>
        <title>${esc(label)} · ${esc(GRAPH_TYPE[type] || type)} · degree ${esc(String(degrees.get(String(node.id)) || 0))}</title>
      </g>`
    }).join('')
    return `<div class="loop-graph-wrap">
      <svg class="loop-graph" viewBox="0 0 820 520" role="img" aria-label="记忆图谱，节点按类型着色">
        <g class="loop-edges">${edgeSvg}</g>
        <g class="loop-nodes">${nodeSvg}</g>
      </svg>
      <div class="loop-graph-legend">
        <span style="color:${GRAPH_COLOR.memory}">● 记忆</span>
        <span style="color:${GRAPH_COLOR.object}">● 本体对象</span>
        <span style="color:${GRAPH_COLOR.rule}">● 规则</span>
      </div>
    </div>`
  }

  /* ---------------------------------------------------------------- 视图分发 */

  const VIEWS = {
    import: importView,
    memory: memoryView,
    ontology: ontologyView,
    rules: rulesView,
    skills: skillsView,
    context: contextView,
    graph: graphView,
  }

  function render() {
    if (closed) return
    const fn = VIEWS[view] || importView
    const err = state.viewError[view]
    const loading = !!state.loading[view]
    let content = ''
    if (!loading) {
      try {
        content = fn()
      } catch (e) {
        console.error(e)
        content = `<div class="loop-card">${errorHtml(e)}</div>`
      }
    }
    bodyEl.innerHTML = `${stats()}
      ${err ? `<div class="loop-card">${errorHtml(err, `<div class="loop-actions"><button class="loop-btn loop-btn-sm" type="button" data-loop-action="retry-view" data-id="${esc(view)}">重试</button></div>`)}</div>` : ''}
      ${loading ? loadingBlock('正在读取…') : content}`
    root.querySelectorAll('[data-view]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.view === view)
      b.setAttribute('aria-selected', String(b.dataset.view === view))
    })
  }

  /* ---------------------------------------------------------------- 文件 / 附件 */

  function readConversationFile(file) {
    const ext = fileExt(file.name)
    if (!ALLOWED_EXT.includes(ext)) return toast('仅支持 .json / .md / .markdown / .txt 文件')
    if (file.size > MAX_FILE) return toast('文件超过 20MB，请拆分后再导入')
    if (!file.size) return toast('文件为空，无法导入')
    state.fileReading = true
    render()
    const reader = new FileReader()
    reader.onload = () => {
      state.fileReading = false
      const text = String(reader.result || '')
      if (text.indexOf('\u0000') >= 0) {
        state.file = null
        render()
        return toast('文件包含 NUL 字符，已拒绝（可能不是文本文件）')
      }
      if (!text.trim()) {
        state.file = null
        render()
        return toast('文件内容为空')
      }
      state.file = { name: file.name, size: file.size, type: file.type || '' }
      state.forms.import.filename = file.name
      state.forms.import.format = ext === 'json' ? 'json' : 'text'
      state.forms.import.mimeType = file.type || ''
      state.forms.import.sizeBytes = file.size
      state.forms.import.text = text
      state.preview = null
      state.previewError = null
      state.roleOverrides = {}
      saveDraft(text)
      persistForms()
      render()
      toast(`已读取 ${file.name}（${fmtBytes(file.size)}），可预览后导入`)
    }
    reader.onerror = () => {
      state.fileReading = false
      render()
      toast('文件读取失败，请重试')
    }
    reader.readAsText(file)
  }

  function registerAttachment(file) {
    if (state.attachments.length >= 20) { toast('附件最多登记 20 个'); return }
    if (state.attachments.some((a) => a.name === file.name && a.size === file.size && a.type === (file.type || ''))) return
    state.attachments.push({ name: file.name, size: file.size, type: file.type || '' })
  }

  /* ---------------------------------------------------------------- 详情 */

  // 兼容 host 迁移期：detail 路由可能暂时回退成 list 形状（{ok, items}）。
  function adaptImportDetail(out, id) {
    if (out && (out.source || Array.isArray(out.messages))) return out
    const src = pickItem(out, id) || {}
    return { source: src, messages: [], batches: Array.isArray(src.batches) ? src.batches : [], derived: src.derived || {}, warnings: src.warnings || [] }
  }
  function adaptMemoryDetail(out, id) {
    if (out && out.memory) return out
    const mem = pickItem(out, id) || {}
    return { memory: mem, versions: Array.isArray(out?.versions) ? out.versions : [], evidence: Array.isArray(mem.evidence) ? mem.evidence : [] }
  }
  function adaptOntologyInstance(out, id) {
    if (out && out.instance) return out
    const inst = pickItem(out, id) || {}
    return { instance: inst, properties: Array.isArray(inst.properties) ? inst.properties : [], relations: Array.isArray(inst.relations) ? inst.relations : [], state_history: Array.isArray(inst.state_history) ? inst.state_history : [] }
  }

  async function openSourceDetail(id) {
    state.sourceDetail = { id, loading: true }
    render()
    try {
      const out = await api.loopImportDetail(id)
      state.sourceDetail = { id, data: adaptImportDetail(out, id) }
    } catch (e) {
      state.sourceDetail = { id, error: e }
    }
    render()
  }

  async function openMemoryDetail(id) {
    state.memDetail = { id, loading: true }
    render()
    try {
      const out = await api.loopMemory(id)
      state.memDetail = { id, data: adaptMemoryDetail(out, id) }
    } catch (e) {
      state.memDetail = { id, error: e }
    }
    render()
  }

  async function reloadInstance(id) {
    try {
      const out = await api.loopOntologyInstance(id)
      state.instDetails[id] = { data: adaptOntologyInstance(out, id) }
    } catch (e) {
      state.instDetails[id] = { error: e }
    }
  }
  async function refreshOntology() {
    state.ontology = await api.loopOntology()
  }

  /* ---------------------------------------------------------------- 筛选刷新 */

  async function refreshMemoriesView() {
    try { await fetchMemories(); state.viewError.memory = null; render() }
    catch (e) { state.viewError.memory = e; render() }
  }
  async function refreshRulesView() {
    try { await fetchRules(); state.viewError.rules = null; render() }
    catch (e) { state.viewError.rules = e; render() }
  }
  async function refreshSkillsView() {
    try { await fetchSkills(); state.viewError.skills = null; render() }
    catch (e) { state.viewError.skills = e; render() }
  }
  async function refreshGraphView() {
    await fetchGraph()
    render()
  }

  /* ---------------------------------------------------------------- 动作 */

  async function handleAction(act, el) {
    const id = el.dataset.id || ''
    // 上一次操作留下的视图级错误在开始新操作时清除；真正的失败会在 catch 里重新写入。
    if (state.viewError[view]) state.viewError[view] = null

    /* ---------- 导入 ---------- */
    if (act === 'pick-text-file') { bodyEl.querySelector('#loop-file')?.click(); return }
    if (act === 'pick-attachment') { bodyEl.querySelector('#loop-attach')?.click(); return }
    if (act === 'sample') {
      const t = bodyEl.querySelector('#loop-text')
      const sample = JSON.stringify({ messages: [
        { role: 'user', content: 'WELL_001 现在检修，先不要做参数优化，恢复生产后再进行。' },
        { role: 'assistant', content: '收到，我会记录这条限制，不会自动启动优化任务。' },
        { role: 'user', content: '以后给我方案时先给结论，再给依据。' },
      ] }, null, 2)
      if (t) t.value = sample
      state.forms.import.text = sample
      state.forms.import.format = 'json'
      saveDraft(sample)
      render()
      return
    }
    if (act === 'clear-file') {
      state.file = null
      state.forms.import.filename = ''
      render()
      return
    }
    if (act === 'preview') {
      const text = state.forms.import.text || ''
      if (!text.trim()) return toast('请先输入或选择对话内容')
      state.preview = null
      state.previewError = null
      state.roleOverrides = {}
      try {
        state.preview = await api.loopPreview({ text, format: state.forms.import.format || 'auto' })
      } catch (e) {
        state.previewError = e
      }
      render()
      return
    }
    if (act === 'import') {
      const f = state.forms.import
      const text = f.text || ''
      if (!text.trim()) return toast('请先输入或选择对话内容')
      const payload = {
        text,
        format: f.format || 'auto',
        owner: f.owner || 'local-user',
        autoExtract: f.autoExtract === '1',
      }
      if (String(f.project || '').trim()) payload.project = String(f.project).trim()
      if (String(f.task || '').trim()) payload.task = String(f.task).trim()
      if (String(f.platform || '').trim()) payload.platform = String(f.platform).trim()
      if (String(f.externalConversationId || '').trim()) payload.externalConversationId = String(f.externalConversationId).trim()
      if (String(f.title || '').trim()) payload.title = String(f.title).trim()
      if (String(f.filename || '').trim()) payload.filename = String(f.filename).trim()
      if (Object.keys(state.roleOverrides).length) payload.roleOverrides = { ...state.roleOverrides }
      if (state.attachments.length) payload.attachments = state.attachments.map((a) => ({ name: a.name, size: a.size, type: a.type }))
      if (state.file) {
        if (state.file.type) payload.mimeType = state.file.type
        if (state.file.size) payload.sizeBytes = state.file.size
      }
      const out = await api.loopImport(payload)
      state.importResult = { out }
      state.preview = null
      state.previewError = null
      state.roleOverrides = {}
      if (out.duplicate) toast('文件已导入过，未重复创建')
      else if (out.job_id) toast(`已导入 ${fmt(out.appended || 0)} 条消息；拆解任务已入队 ${out.job_id}`, 4000)
      else toast(`已导入 ${fmt(out.appended || 0)} 条消息（未拆解）`, 3600)
      await refreshImports()
      await refreshJobs()
      await refreshOverview()
      if (out.job_id) { state.jobDetail = out.job; startJobPoll(out.job_id) }
      render()
      return
    }
    if (act === 'remove-attachment') {
      state.attachments.splice(Number(id), 1)
      render()
      return
    }
    if (act === 'jobs-refresh') { await refreshJobs(); render(); return }
    if (act === 'job-poll') { await refreshJobs(); state.jobDetail = (await api.loopJob(id)).job; startJobPoll(id); render(); return }
    if (act === 'job-retry') {
      const out = await api.loopRetryJob(id)
      state.jobDetail = out.job
      await refreshJobs(); startJobPoll(id); render()
      toast('任务已重新入队')
      return
    }
    if (act === 'job-cancel') {
      const out = await api.loopCancelJob(id)
      state.jobDetail = out.job
      await refreshJobs(); render()
      toast(out.job.status === 'cancelled' ? '任务已取消' : '已请求取消，当前分块结束后停止')
      return
    }
    if (act === 'watch-batch') { startBatchPoll(id); render(); return }
    if (act === 'batch-panel-close') {
      stopBatchPoll()
      state.batchSource = ''
      state.batches = []
      state.batchesError = null
      render()
      return
    }
    if (act === 'source-detail') { await openSourceDetail(id); return }
    if (act === 'open-source') { await openSourceDetail(id); return }
    if (act === 'close-source-detail') {
      state.sourceDetail = null
      state.archiveConfirm = ''
      render()
      return
    }
    if (act === 'extract') {
      const sourceId = id
      state.extractStarting[sourceId] = true
      state.extractErrors[sourceId] = null
      try {
        const out = await api.loopExtract(sourceId)
        state.extractResults[sourceId] = out
        state.jobDetail = out.job
        await refreshJobs()
        startJobPoll(out.job_id)
        toast(`拆解任务已入队：${out.job_id}`, 3600)
      } catch (e) {
        state.extractErrors[sourceId] = e
        toast(errorInfo(e).message, 3600)
      } finally {
        state.extractStarting[sourceId] = false
        updateSourceList()
        render()
      }
      return
    }
    if (act === 'retry-batch') {
      let sourceId = el.dataset.sourceId || state.batchSource || ''
      if (!sourceId) {
        for (const s of state.imports) {
          if ((s.batches || []).some((b) => b.id === id)) { sourceId = s.id; break }
        }
      }
      await api.loopRetryBatch(id)
      toast('已重试失败分块')
      if (sourceId) startBatchPoll(sourceId)
      render()
      return
    }
    if (act === 'archive-source') {
      state.archiveConfirm = id
      await openSourceDetail(id)
      return
    }
    if (act === 'archive-source-confirm') {
      const out = await api.loopArchiveImport(id)
      state.archiveResult = { sourceId: id, archived: out.archived || {}, note: out.note || '' }
      state.archiveConfirm = ''
      toast(`已归档：受影响记忆 ${fmt(out.archived?.memories ?? 0)} 条 · 规则 ${fmt(out.archived?.rules ?? 0)} 条`, 4000)
      await refreshImports()
      await refreshOverview()
      await openSourceDetail(id)
      return
    }
    if (act === 'archive-source-cancel') {
      state.archiveConfirm = ''
      render()
      return
    }

    /* ---------- 记忆 ---------- */
    if (act === 'memories') { await refreshMemoriesView(); return }
    if (act === 'memories-clear') {
      state.filters.memory = { type: '', status: '', scope_type: '', source_id: '', q: '' }
      persistFilters()
      await refreshMemoriesView()
      return
    }
    if (act === 'mem-merge-panel') { state.mergePanel = true; render(); return }
    if (act === 'mem-merge-cancel') { state.mergePanel = false; render(); return }
    if (act === 'mem-merge') {
      const input = (bodyEl.querySelector('#loop-merge-ids')?.value || '').trim()
      const text = (bodyEl.querySelector('#loop-merge-text')?.value || '').trim()
      const fromInput = input.split(',').map((s) => s.trim()).filter(Boolean)
      const list = fromInput.length ? fromInput : [...state.memSelected]
      if (list.length < 2) { setOpError('mem-merge', validationError('至少需要 2 条记忆才能合并')); return }
      const target = list[0]
      const out = await api.loopMergeMemory(target, { ids: list, text: text || undefined })
      toast(`已合并 ${fmt((out.merged_ids || list).length)} 条记忆，目标 ${out.memory?.id || target}`)
      state.mergePanel = false
      state.mergeIds = ''
      state.memSelected.clear()
      await fetchMemories()
      await refreshOverview()
      render()
      return
    }
    if (act === 'mem-edit-open') {
      state.memEdit = state.memEdit && state.memEdit.id === id ? null : { id }
      render()
      return
    }
    if (act === 'mem-edit-cancel') { state.memEdit = null; render(); return }
    if (act === 'mem-edit-save') {
      const panel = el.closest('.loop-panel')
      const text = panel?.querySelector('[data-mem-text]')?.value || ''
      const objRaw = panel?.querySelector('[data-mem-object]')?.value || ''
      const payload = {}
      if (text.trim()) payload.text = text
      if (objRaw.trim()) payload.object_value = parseMaybeJson(objRaw)
      if (!Object.keys(payload).length) { setOpError(`mem-edit:${id}`, validationError('没有需要保存的字段')); return }
      try {
        const out = await api.loopPatchMemory(id, payload)
        toast(`已保存，版本 v${out.memory?.version ?? '?'}`)
        state.memEdit = null
        await fetchMemories()
        await refreshOverview()
        render()
      } catch (e) {
        setOpError(`mem-edit:${id}`, e)
      }
      return
    }
    if (act === 'mem-versions') {
      const cur = state.memVersions[id]
      if (cur && !cur.loading && !cur.error) { delete state.memVersions[id]; render(); return }
      state.memVersions[id] = { loading: true }
      render()
      try {
        const out = await api.loopMemoryVersions(id)
        state.memVersions[id] = { items: out.items || [] }
      } catch (e) {
        state.memVersions[id] = { error: e }
      }
      render()
      return
    }
    if (act === 'mem-versions-close') {
      for (const key of Object.keys(state.memVersions)) delete state.memVersions[key]
      render()
      return
    }
    if (act === 'memory-detail') { await openMemoryDetail(id); return }
    if (act === 'memory-detail-close') { state.memDetail = null; render(); return }
    if (act === 'show-correct') {
      const box = bodyEl.querySelector(`#correct-${window.CSS?.escape ? CSS.escape(id) : cssSafe(id)}`)
      if (box) box.hidden = !box.hidden
      return
    }
    if (act === 'correct-memory') {
      const box = bodyEl.querySelector(`#correct-${window.CSS?.escape ? CSS.escape(id) : cssSafe(id)}`)
      const text = (box?.querySelector('textarea')?.value || '').trim()
      if (!text) return toast('纠正内容不能为空')
      await api.loopCorrect(id, { action: 'supersede', text })
      toast('已建立替代关系，旧记忆保留但退出当前视图')
      await fetchMemories()
      await refreshOverview()
      render()
      return
    }
    if (act === 'confirm-memory') {
      await api.loopCorrect(id, { action: 'confirm' })
      toast('记忆已确认')
      await fetchMemories()
      await refreshOverview()
      render()
      return
    }
    if (act === 'archive-memory') {
      await api.loopCorrect(id, { action: 'archive' })
      toast('记忆已废弃')
      await fetchMemories()
      await refreshOverview()
      render()
      return
    }

    /* ---------- 本体 ---------- */
    if (act === 'ontology-versions-refresh') {
      await refreshOntologyVersions()
      state.ontology = await api.loopOntology()
      render()
      return
    }
    if (act === 'ontology-version-diff') {
      try { state.ontologyVersionDiff = await api.loopOntologyVersionDiff(id) } catch (e) { state.ontologyVersionError = e }
      render()
      return
    }
    if (act === 'ontology-version-diff-close') { state.ontologyVersionDiff = null; render(); return }
    if (act === 'ontology-version-rollback') {
      const note = document.querySelector('#ont-rollback-note')?.value || ''
      try {
        const out = await api.loopRollbackOntology(id, { note })
        toast(`已回滚到 v${out.target_version}，生成新版本 v${out.version}`)
        state.ontologyRollback = null
        state.ontology = await api.loopOntology()
        await refreshOntologyVersions()
        render()
      } catch (e) {
        const payload = (e && e.payload) || {}
        if (payload.error === 'rollback_has_impact') {
          state.ontologyRollback = { id, impact: payload.impact, note }
          state.ontologyVersionError = null
          render()
        } else {
          setOpError('ontology-rollback', e)
        }
      }
      return
    }
    if (act === 'ontology-version-rollback-confirm') {
      const note = document.querySelector('#ont-rollback-note')?.value || state.ontologyRollback?.note || ''
      try {
        const out = await api.loopRollbackOntology(id, { note, confirm_impact: true })
        toast(`已回滚到 v${out.target_version}，生成新版本 v${out.version}`)
        state.ontologyRollback = null
        state.ontology = await api.loopOntology()
        await refreshOntologyVersions()
        render()
      } catch (e) { setOpError('ontology-rollback', e) }
      return
    }
    if (act === 'ontology-version-rollback-cancel') { state.ontologyRollback = null; render(); return }
    if (act === 'ontology-refresh') { await loadView('ontology', { showLoading: false }); return }
    if (act === 'instance-open') {
      const cur = state.instDetails[id]
      if (cur && cur.data) { delete state.instDetails[id]; render(); return }
      state.instDetails[id] = { loading: true }
      render()
      await reloadInstance(id)
      render()
      return
    }
    if (act === 'instance-prop') {
      const panel = el.closest('.loop-panel')
      const propId = panel?.querySelector('[data-prop-select]')?.value || ''
      const name = (panel?.querySelector('[data-prop-name]')?.value || '').trim()
      const value = panel?.querySelector('[data-prop-value]')?.value || ''
      const unit = (panel?.querySelector('[data-prop-unit]')?.value || '').trim()
      if (!propId && !name) return setOpError(`prop:${id}`, validationError('请选择已定义属性，或输入属性名'))
      if (value === '') return setOpError(`prop:${id}`, validationError('属性值不能为空'))
      const payload = {}
      if (propId) payload.prop_id = propId
      else payload.name = name
      payload.value = parseMaybeJson(value)
      if (unit) payload.unit = unit
      try {
        const out = await api.loopSetInstanceProp(id, payload)
        toast(out.converted != null ? `属性已设置；单位已转换：${stringify(out.converted)}` : '属性已设置')
        await reloadInstance(id)
        await refreshOntology()
        render()
      } catch (e) {
        setOpError(`prop:${id}`, e)
      }
      return
    }
    if (act === 'instance-relation') {
      const panel = el.closest('.loop-panel')
      const relationId = panel?.querySelector('[data-rel-select]')?.value || ''
      const name = (panel?.querySelector('[data-rel-name]')?.value || '').trim()
      const target = panel?.querySelector('[data-rel-target]')?.value || ''
      const toName = (panel?.querySelector('[data-rel-to-name]')?.value || '').trim()
      if (!relationId && !name) return setOpError(`rel:${id}`, validationError('请选择已定义关系，或输入关系名'))
      if (!target && !toName) return setOpError(`rel:${id}`, validationError('请选择目标实例，或输入目标名称'))
      const payload = {}
      if (relationId) payload.relation_id = relationId
      else payload.name = name
      if (target) payload.to_instance_id = target
      else payload.to_name = toName
      try {
        await api.loopSetInstanceRelation(id, payload)
        toast('关系已设置')
        await reloadInstance(id)
        await refreshOntology()
        render()
      } catch (e) {
        setOpError(`rel:${id}`, e)
      }
      return
    }
    if (act === 'instance-state') {
      const panel = el.closest('.loop-panel')
      const nextState = panel?.querySelector('[data-state-select]')?.value || ''
      const reason = (panel?.querySelector('[data-state-reason]')?.value || '').trim()
      if (!nextState) return setOpError(`state:${id}`, validationError('请选择目标状态'))
      try {
        await api.loopSetInstanceState(id, { state: nextState, reason: reason || undefined })
        toast(`状态已转换为 ${nextState}`)
        await reloadInstance(id)
        await refreshOntology()
        render()
      } catch (e) {
        setOpError(`state:${id}`, e)
      }
      return
    }
    if (act === 'proposal-approve') {
      try {
        const out = await api.loopApproveProposal(id)
        state.proposalResults[id] = out.applied || { kind: 'unknown' }
        if (out.applied && out.applied.error) toast(`发布失败：${out.applied.error}`, 4000)
        else toast(`已发布：${out.applied?.kind || '结构候选'} ${out.applied?.id || ''}`)
        state.opErrors[`proposal:${id}`] = null
        await refreshOntology()
        await refreshOntologyVersions()
        await refreshOverview()
        render()
      } catch (e) {
        state.opErrors[`proposal:${id}`] = e
        setOpError(`proposal:${id}`, e)
      }
      return
    }
    if (act === 'proposal-reject') {
      await api.loopRejectProposal(id)
      state.proposalResults[id] = { kind: 'rejected' }
      toast('结构候选已拒绝')
      await refreshOntology()
      render()
      return
    }

    /* ---------- 规则 ---------- */
    if (act === 'rules') { await refreshRulesView(); return }
    if (act === 'review-mode') {
      try {
        const out = await api.loopSetReviewMode(id)
        state.reviewMode = out.mode
        toast(`审核模式已切换为「${out.name}」：${out.description}`)
        render()
      } catch (e) { setOpError('review-mode', e); render() }
      return
    }
    if (act === 'resolve-conflict') {
      const resolution = el.dataset.resolution
      const key = id
      const noteEl = document.querySelector(`[data-conflict-note="${CSS.escape(key)}"]`)
      const note = noteEl ? noteEl.value : ''
      try {
        const out = await api.loopResolveConflict(key, { resolution, note, owner: state.forms.context.owner || 'local-user' })
        toast(`裁决已保存：${RESOLUTION[resolution] || resolution}；保留双方规则与版本`)
        await fetchRuleConflicts()
        await fetchRules()
        render()
      } catch (e) { setOpError(`conflict:${key}`, e); render() }
      return
    }
    if (act === 'rules-view') {
      state.filters.rules.view = ['all', 'conflicts', 'unstructured'].includes(id) ? id : 'all'
      persistFilters()
      await refreshRulesView()
      return
    }
    if (act === 'approve-rule') {
      await api.loopApproveRule(id)
      toast('规则已生效')
      await refreshRulesView()
      await refreshOverview()
      return
    }
    if (act === 'pause-rule') {
      await api.loopPauseRule(id)
      toast('规则已暂停')
      await refreshRulesView()
      return
    }
    if (act === 'resume-rule') {
      await api.loopResumeRule(id)
      toast('规则已恢复')
      await refreshRulesView()
      return
    }
    if (act === 'archive-rule') {
      await api.loopArchiveRule(id)
      toast('规则已归档')
      await refreshRulesView()
      return
    }
    if (act === 'show-sim' || act === 'rule-sim-open') {
      state.ruleSimOpen = state.ruleSimOpen === id ? '' : id
      render()
      return
    }
    if (act === 'rule-sim-close') { state.ruleSimOpen = ''; render(); return }
    if (act === 'simulate') {
      const raw = bodyEl.querySelector(`#sim-ctx-${window.CSS?.escape ? CSS.escape(id) : cssSafe(id)}`)?.value || '{}'
      let ctx
      try { ctx = JSON.parse(raw || '{}') } catch { state.ruleSim[id] = { contextText: raw, error: validationError('测试上下文必须是合法 JSON') }; render(); return }
      try {
        const out = await api.loopSimulateRule(id, ctx)
        state.ruleSim[id] = { contextText: raw, out }
      } catch (e) {
        state.ruleSim[id] = { contextText: raw, error: e }
      }
      render()
      return
    }
    if (act === 'rule-versions') {
      const cur = state.ruleVersions[id]
      if (cur && !cur.loading && !cur.error) { delete state.ruleVersions[id]; render(); return }
      state.ruleVersions[id] = { loading: true }
      render()
      try {
        const out = await api.loopRuleVersions(id)
        state.ruleVersions[id] = { items: out.items || [] }
      } catch (e) {
        state.ruleVersions[id] = { error: e }
      }
      render()
      return
    }
    if (act === 'rule-versions-close') {
      for (const key of Object.keys(state.ruleVersions)) delete state.ruleVersions[key]
      render()
      return
    }
    if (act === 'rule-edit-open') {
      state.ruleEdit = state.ruleEdit && state.ruleEdit.id === id ? null : { id, draft: {} }
      render()
      return
    }
    if (act === 'rule-edit-cancel') { state.ruleEdit = null; render(); return }
    if (act === 'rule-edit-save') {
      const panel = el.closest('.loop-panel')
      const field = (k) => panel?.querySelector(`[data-rule-field="${k}"]`)?.value ?? ''
      const jsonField = (k) => panel?.querySelector(`[data-rule-json="${k}"]`)?.value ?? ''
      let conditions, actions, exceptions
      try {
        conditions = JSON.parse(jsonField('conditions') || '{}')
        actions = JSON.parse(jsonField('actions') || '[]')
        exceptions = JSON.parse(jsonField('exceptions') || '[]')
      } catch (err) {
        setOpError(`rule-edit:${id}`, validationError(`JSON 校验失败：${err.message}`))
        return
      }
      const payload = {
        name: field('name'), description: field('description'), category: field('category'),
        scope_type: field('scope_type') || undefined, scope_id: field('scope_id') || undefined,
        strength: field('strength'), conditions, actions, exceptions,
        valid_from: field('valid_from') || undefined, valid_to: field('valid_to') || undefined,
        structure_status: field('structure_status') || undefined,
      }
      try {
        const out = await api.loopPatchRule(id, payload)
        toast(`规则已保存，版本 v${out.rule?.version ?? out.version ?? '?'}`)
        state.ruleEdit = null
        await fetchRules()
        await refreshOverview()
        render()
      } catch (e) {
        setOpError(`rule-edit:${id}`, e)
      }
      return
    }
    if (act === 'rule-supersede-open') {
      state.ruleSupersede = state.ruleSupersede && state.ruleSupersede.id === id ? null : { id, draft: {} }
      render()
      return
    }
    if (act === 'rule-supersede-cancel') { state.ruleSupersede = null; render(); return }
    if (act === 'rule-supersede-save') {
      const panel = el.closest('.loop-panel')
      const field = (k) => panel?.querySelector(`[data-supersede-field="${k}"]`)?.value ?? ''
      const jsonField = (k) => panel?.querySelector(`[data-supersede-json="${k}"]`)?.value ?? ''
      let conditions, actions
      try {
        conditions = JSON.parse(jsonField('conditions') || '{}')
        actions = JSON.parse(jsonField('actions') || '[]')
      } catch (err) {
        setOpError(`rule-supersede:${id}`, validationError(`JSON 校验失败：${err.message}`))
        return
      }
      const activate = !!panel?.querySelector('[data-supersede-activate]')?.checked
      const payload = {
        name: field('name'), description: field('description'), category: field('category'),
        scope_type: field('scope_type') || undefined, scope_id: field('scope_id') || undefined,
        valid_from: field('valid_from') || undefined, valid_to: field('valid_to') || undefined,
        strength: field('strength'), conditions, actions, activate,
      }
      try {
        const out = await api.loopSupersedeRule(id, payload)
        toast(`已创建替代规则 ${out.rule?.id || out.id || ''}${activate ? '（已生效）' : '（候选）'}`, 3600)
        state.ruleSupersede = null
        await fetchRules()
        await refreshOverview()
        render()
      } catch (e) {
        setOpError(`rule-supersede:${id}`, e)
      }
      return
    }

    /* ---------- Skill ---------- */
    if (act === 'skills-refresh') { await refreshSkillsView(); return }
    if (act === 'skills-derive') {
      const project = (state.forms.skills.project || '').trim()
      const min = Number(state.forms.skills.min_memories)
      const out = await api.loopDeriveSkills({
        project: project || undefined,
        min_memories: Number.isFinite(min) && min > 0 ? min : undefined,
      })
      state.skillDerive = out
      state.skills = Array.isArray(out.items) ? out.items : (await api.loopSkills(qs({ status: state.filters.skills.status }))).items || []
      const derivedCount = Array.isArray(out.items) ? out.items.length : (Number(out.derived) || 0)
      toast(`已生成 ${fmt(derivedCount)} 个 Skill 候选`)
      await refreshOverview()
      render()
      return
    }
    if (act === 'skill-edit-open') {
      state.skillEdit = state.skillEdit && state.skillEdit.id === id ? null : { id }
      render()
      return
    }
    if (act === 'skill-edit-cancel') { state.skillEdit = null; render(); return }
    if (act === 'skill-edit-save') {
      const panel = el.closest('.loop-panel')
      const field = (k) => panel?.querySelector(`[data-skill-field="${k}"]`)?.value ?? ''
      const jsonField = (k) => panel?.querySelector(`[data-skill-json="${k}"]`)?.value ?? ''
      let parsed = {}
      try {
        for (const k of ['inputs', 'preconditions', 'steps', 'exceptions', 'boundaries']) {
          const v = JSON.parse(jsonField(k) || '[]')
          if (!Array.isArray(v)) throw new Error(`${k} 必须是数组`)
          parsed[k] = v
        }
      } catch (err) {
        setOpError(`skill-edit:${id}`, validationError(`JSON 校验失败：${err.message}`))
        return
      }
      const payload = {
        name: field('name'), scenario: field('scenario'), output_format: field('output_format'),
        acceptance: field('acceptance'), ...parsed,
      }
      try {
        await api.loopPatchSkill(id, payload)
        toast('Skill 候选已保存')
        state.skillEdit = null
        await fetchSkills()
        render()
      } catch (e) {
        setOpError(`skill-edit:${id}`, e)
      }
      return
    }
    if (act === 'skill-export') {
      const out = await api.loopExportSkill(id)
      const filename = out.filename || `skill-${id}.md`
      if (downloadText(out.markdown || '', filename)) toast(`已导出 ${filename}`)
      else toast('下载失败，浏览器可能阻止了文件保存')
      return
    }
    if (act === 'skill-reject') {
      await api.loopRejectSkill(id)
      toast('已忽略该 Skill 候选')
      await fetchSkills()
      await refreshOverview()
      render()
      return
    }

    /* ---------- 上下文 / 反馈 ---------- */
    if (act === 'context') {
      let obj = {}
      try { obj = JSON.parse(state.forms.context.object || '{}') } catch { toast('业务对象 JSON 必须是合法 JSON', 3600); return }
      const f = state.forms.context
      const budget = Number(f.budget)
      const payload = {
        owner: f.owner || undefined,
        project: f.project || undefined,
        task: f.task || undefined,
        instruction: f.instruction || undefined,
        query: f.query || undefined,
        include_sensitive: !!f.includeSensitive,
        budget: Number.isFinite(budget) && budget > 0 ? budget : undefined,
        ...obj,
      }
      try {
        const out = await api.loopContext(payload)
        state.contextResult = out
        state.contextError = null
        toast(`已生成上下文：${fmt(out.usage || 0)}/${fmt(out.budget || 0)} 字符`)
        await refreshRunsAndFeedback()
        render()
      } catch (e) {
        state.contextError = e
        render()
        toast(errorInfo(e).message, 4000)
      }
      return
    }
    if (act === 'vector-probe') { await refreshVectorStatus(true); render(); return }
    if (act === 'vector-refresh') { await refreshVectorStatus(); render(); return }
    if (act === 'vector-reindex') {
      try {
        const out = await api.loopReindexEmbeddings({ owner: state.forms.context.owner || 'local-user' })
        state.vectorJob = out.job
        await refreshVectorStatus()
        toast(`向量重建任务已入队：${out.job?.id || '—'}（${fmt(out.queued || 0)} 条）`, 4000)
        if (out.job?.id) startJobPoll(out.job.id)
        render()
      } catch (e) { setOpError('vector', e); render() }
      return
    }
    if (act === 'action-check') {
      let obj = {}
      try { obj = JSON.parse(state.forms.context.object || '{}') } catch { toast('业务对象 JSON 必须是合法 JSON', 3600); return }
      const f = state.forms.context
      const af = state.forms.action || {}
      const payload = {
        owner: f.owner || undefined, project: f.project || undefined, task: f.task || undefined,
        instruction: f.instruction || undefined, query: f.query || undefined,
        include_sensitive: !!f.includeSensitive,
        authorized: !!af.authorized, authorization_note: String(af.note || '').trim() || undefined,
        action: { type: af.type || 'execute', target: String(af.target || '').trim() || undefined },
        ...obj,
      }
      try {
        const out = await api.loopActionCheck(payload)
        state.actionResult = out
        state.actionError = null
        toast(`动作校验：${out.result}${out.executed ? '' : '（未执行）'}`, 3600)
        await refreshRunsAndFeedback()
        render()
      } catch (e) {
        state.actionError = e
        setOpError('action', e)
      }
      return
    }
    if (act === 'action-refresh') {
      await refreshRunsAndFeedback()
      toast('动作记录已刷新')
      render()
      return
    }
    if (act === 'feedback-submit') {
      const f = state.forms.feedback
      const payload = { outcome: f.outcome || 'useful' }
      if (String(f.run_id || '').trim()) payload.run_id = String(f.run_id).trim()
      if (f.category) payload.category = f.category
      if (String(f.feedback || '').trim()) payload.feedback = String(f.feedback).trim()
      if (f.rule_id) payload.rule_id = f.rule_id
      if (String(f.memory_id || '').trim()) payload.memory_id = String(f.memory_id).trim()
      if (String(f.correction || '').trim()) payload.correction = { text: String(f.correction).trim() }
      try {
        const out = await api.loopFeedback(payload)
        state.feedbackResult = out
        toast('反馈已记录')
        await refreshRunsAndFeedback()
        render()
      } catch (e) {
        setOpError('feedback', e)
      }
      return
    }
    if (act === 'feedback-quick') {
      const outcome = el.dataset.outcome || 'useful'
      await api.loopFeedback({ run_id: id, outcome })
      toast('反馈已记录')
      await refreshRunsAndFeedback()
      render()
      return
    }

    /* ---------- 图谱 ---------- */
    if (act === 'graph-refresh') { await refreshGraphView(); return }
    if (act === 'graph-projection') {
      if (typeof window.__MB_SET_GRAPH__ !== 'function') return toast('当前页面未提供投射接口')
      const target = state.graphProjection === 'loop' ? 'base' : 'loop'
      try {
        await window.__MB_SET_GRAPH__(target, {owner:state.filters.graph.owner,project:state.filters.graph.project,limit:150})
        state.graphProjection = target
        toast(target === 'loop' ? '已投射闭环图谱到中央大脑' : '已恢复原始大脑图谱')
        render()
      } catch (e) {
        toast(`投射失败：${errorInfo(e).message}`, 3600)
      }
      return
    }
    if (act === 'graph-prev') { state.graphPage = Math.max(0, (state.graphPage || 0) - 1); render(); return }
    if (act === 'graph-next') { state.graphPage = (state.graphPage || 0) + 1; render(); return }
    if (act === 'graph-node-close') { state.graphSelected = null; render(); return }

    /* ---------- 其他 ---------- */
    if (act === 'retry-view') {
      await loadView(view, { showLoading: true })
      return
    }
  }

  /* ---------------------------------------------------------------- 事件 */

  listen('click', async (e) => {
    const tab = e.target.closest('[data-view]')
    if (tab) {
      const next = tab.dataset.view
      if (next && VIEWS[next]) {
        view = next
        state.view = next
        storeSet('session', STORE_KEY.view, next)
        state.graphSelected = null
        await loadView(next, { showLoading: true })
      }
      return
    }
    if (e.target.closest('[data-close]')) return close()
    const actionEl = e.target.closest('[data-loop-action]')
    if (!actionEl) {
      const nodeEl = e.target.closest('[data-node-id]')
      if (nodeEl) {
        state.graphSelected = nodeEl.dataset.nodeId
        render()
      }
      return
    }
    if (actionEl.disabled || state.busy) return
    const act = actionEl.dataset.loopAction
    try {
      setBusy(true)
      await handleAction(act, actionEl)
    } catch (err) {
      console.error(err)
      toast(errorInfo(err).message || '操作失败', 3600)
      state.viewError[view] = err
      render()
    } finally {
      setBusy(false)
    }
  })

  listen('change', (e) => {
    const t = e.target
    if (t.matches('#loop-file')) {
      const f = t.files && t.files[0]
      t.value = ''
      if (f) readConversationFile(f)
      return
    }
    if (t.matches('#loop-attach')) {
      const files = [...(t.files || [])]
      t.value = ''
      for (const f of files) registerAttachment(f)
      render()
      return
    }
    if (t.matches('[data-role-index]')) {
      const idx = Number(t.dataset.roleIndex)
      const def = state.preview?.messages?.find((m) => Number(m.index) === idx)?.role
      if (t.value === def) delete state.roleOverrides[idx]
      else state.roleOverrides[idx] = t.value
      render()
      return
    }
    if (t.matches('[data-mem-select]')) {
      const mid = t.dataset.memSelect
      if (t.checked) state.memSelected.add(mid)
      else state.memSelected.delete(mid)
      const countEl = bodyEl.querySelector('#loop-mem-selected')
      if (countEl) countEl.textContent = String(state.memSelected.size)
      return
    }
    const conflictNote = t.closest('[data-conflict-note]')
    if (conflictNote) { state.conflictNotes[conflictNote.dataset.conflictNote] = conflictNote.value; return }
    const filterEl = t.closest('[data-filter]')
    if (filterEl) {
      const path = filterEl.dataset.filter
      setDeep(state.filters, path, filterEl.value)
      persistFilters()
      if (path.endsWith('.q')) return
      if (path.startsWith('memory.')) refreshMemoriesView()
      else if (path.startsWith('rules.')) refreshRulesView()
      else if (path.startsWith('skills.')) refreshSkillsView()
      else if (path.startsWith('graph.')) refreshGraphView()
      return
    }
    const fieldEl = t.closest('[data-f]')
    if (fieldEl) {
      const value = fieldEl.type === 'checkbox' ? fieldEl.checked : fieldEl.value
      setDeep(state.forms, fieldEl.dataset.f, value)
      persistForms()
      return
    }
  })

  listen('input', (e) => {
    const t = e.target
    const fieldEl = t.closest('[data-f]')
    if (fieldEl && fieldEl.type !== 'checkbox') {
      const value = fieldEl.value
      setDeep(state.forms, fieldEl.dataset.f, value)
      if (fieldEl.dataset.draft) saveDraft(value)
      else schedulePersistForms()
      return
    }
    const conflictNote = t.closest('[data-conflict-note]')
    if (conflictNote) { state.conflictNotes[conflictNote.dataset.conflictNote] = conflictNote.value; return }
    const filterEl = t.closest('[data-filter]')
    if (filterEl) {
      const path = filterEl.dataset.filter
      setDeep(state.filters, path, filterEl.value)
      persistFilters()
      if (path === 'memory.q') {
        clearTimeout(qTimer)
        qTimer = setTimeout(() => { refreshMemoriesView() }, 350)
      }
    }
  })

  // 拖放：只接受抽屉内的 drop 区
  listen('dragover', (e) => {
    const zone = e.target.closest('#loop-drop')
    if (!zone) return
    e.preventDefault()
    zone.classList.add('is-over')
  })
  listen('dragleave', (e) => {
    const zone = e.target.closest('#loop-drop')
    if (zone) zone.classList.remove('is-over')
  })
  listen('drop', (e) => {
    const zone = e.target.closest('#loop-drop')
    if (!zone) return
    e.preventDefault()
    zone.classList.remove('is-over')
    const file = e.dataTransfer?.files?.[0]
    if (file) readConversationFile(file)
  })

  /* ---------------------------------------------------------------- 启动 */

  loadView(view, { showLoading: true })
}
