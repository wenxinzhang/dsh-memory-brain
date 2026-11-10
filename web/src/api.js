// api.js — 数据访问
// 1) DSH 插件：<prefix>/api/all（host 半边把 payload JSON 拼成一整包）
// 2) 独立运行：静态 ./data/payload.json
// 搜索/节点详情同样先走 API，失败时退化为本地过滤，保证页面始终可用。

const API_BASE =
  (typeof window !== 'undefined' && window.__MC_API_BASE__) || '/api'

let cache = null

/**
 * 统一请求：保留契约里的 error/detail（例如 unit_conflict 的 expected/got），
 * 供 UI 显示可读错误、接口路径与重试建议。仍然在非 2xx 时抛错。
 */
async function jsonFetch(url, opts) {
  let res
  try {
    res = await fetch(url, { cache: 'no-store', ...opts })
  } catch (e) {
    const err = new Error(`无法连接 ${url}`)
    err.path = url
    err.network = true
    err.cause = e
    throw err
  }
  let text = ''
  try { text = await res.text() } catch {}
  let data = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = null }
  }
  if (!res.ok) {
    const raw = (data && (data.error || data.message)) || ''
    const looksHtml = /^\s*</.test(text) || /<html[\s>]/i.test(text)
    const err = new Error(raw ? String(raw) : `HTTP ${res.status}`)
    err.status = res.status
    err.path = url
    err.payload = data || null
    err.body = looksHtml ? '' : text
    throw err
  }
  if (data == null) {
    const err = new Error(`响应不是合法 JSON：${url}`)
    err.path = url
    err.status = res.status
    throw err
  }
  return data
}

async function fallbackPayload() {
  try { return await jsonFetch('./data/payload.json') } catch { return jsonFetch('./data/sample-payload.json') }
}

export async function loadAll() {
  if (cache) return cache
  let data
  try {
    data = await jsonFetch(`${API_BASE}/all`)
  } catch (e) {
    console.info('[api] API 不可用，使用静态 payload：', e.message)
    data = await fallbackPayload()
    data = {...data,status:{...data.status,connected:false,degraded:true,syncLabel:'服务不可用 · 静态回退',error:e.message}}
  }
  cache = normalize(data)
  return cache
}

export function clearCache() { cache = null }

/** 兼容旧字段，统一成新页面契约 */
function normalize(d) {
  const out = { ...d }
  const ov = out.overview || {}
  out.overview = {
    conversationOriginals: ov.conversationOriginals ?? ov.originalCount ?? 0,
    derivedFacts: ov.derivedFacts ?? 0,
    vectorIndex: ov.vectorIndex ?? ov.vectors ?? 0,
    loaded: ov.loaded ?? (out.memories || []).length,
    total: ov.total ?? ov.activeMemories ?? (out.memories || []).length,
    timeRange: ov.timeRange || '最近30天',
    memoryType: ov.memoryType || '全部类型',
    updatedAt: ov.updatedAt || '',
    ...ov,
  }
  out.graph = out.graph || out.brain || { nodes: [], edges: [], memories: [] }
  out.memories = Array.isArray(out.memories) ? out.memories : []
  out.functionEntries = Array.isArray(out.functionEntries) ? out.functionEntries : []
  out.runtime = out.runtime || {}
  out.runtime.tabs = Array.isArray(out.runtime.tabs) ? out.runtime.tabs : []
  out.toneOf = out.toneOf || null
  return out
}

/** 本地兜底搜索：记忆文本 + 图谱实体名 */
function localSearch(data, q, limit) {
  const ql = String(q || '').toLowerCase()
  if (!ql) return { query: q, items: [], total: 0 }
  const items = []
  for (const m of data.memories || []) {
    const text = m.text || ''
    if (text.toLowerCase().includes(ql)) {
      items.push({
        id: `m${m.id}`, sourceId: m.id, type: 'memory', kind: m.kind,
        tone: m.tone, text, name: text, score: m.importance ?? 0.5,
        created_at: m.created_at,
      })
    }
    if (items.length >= limit * 3) break
  }
  for (const n of data.graph?.nodes || []) {
    if (String(n.name || '').toLowerCase().includes(ql)) {
      items.push({
        id: `e${n.id}`, sourceId: n.id, type: 'node', kind: n.type,
        text: n.name, name: n.name, score: 1 + Math.min(n.degree || 0, 50) / 100,
      })
    }
  }
  items.sort((a, b) => (b.score || 0) - (a.score || 0))
  return { query: q, items: items.slice(0, limit), total: items.length }
}

export async function search(q, limit = 8) {
  const query = String(q || '').trim()
  if (!query) return { query, items: [], total: 0 }
  try {
    return await jsonFetch(`${API_BASE}/search?q=${encodeURIComponent(query)}&limit=${limit}`)
  } catch {
    const data = await loadAll()
    return localSearch(data, query, limit)
  }
}

export async function getNode(id, data) {
  try {
    return await jsonFetch(`${API_BASE}/node/${encodeURIComponent(id)}`)
  } catch {
    const d = data || (await loadAll())
    const raw = String(id).replace(/^[em]/, '')
    const mem = (d.graph?.memories || []).find((m) => String(m.id) === raw)
    if (mem) {
      return {
        id: `m${mem.id}`, name: mem.text, kind: mem.kind, type: 'memory',
        text: mem.text, importance: mem.importance, created_at: mem.created_at,
      }
    }
    const node = (d.graph?.nodes || []).find((n) => String(n.id) === raw)
    if (node) return { id: `e${node.id}`, name: node.name, type: node.type, degree: node.degree }
    return null
  }
}

/* ---------------- 规则提炼 ---------------- */
export async function getRules() {
  return jsonFetch(`${API_BASE}/rules`)
}

export async function getRulesStatus() {
  return jsonFetch(`${API_BASE}/rules/status`)
}

export async function extractRules(options = {}) {
  return jsonFetch(`${API_BASE}/rules/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options || {}),
  })
}

export async function approveRule(id) {
  return jsonFetch(`${API_BASE}/rules/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
}

export async function rejectRule(id) {
  return jsonFetch(`${API_BASE}/rules/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
}

export async function deleteRule(id) {
  return jsonFetch(`${API_BASE}/rules/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
}

export async function getRulesSources() {
  return jsonFetch(`${API_BASE}/rules/sources`)
}

/* ---------------- 记忆闭环 v2 ---------------- */
/**
 * 契约见 docs/loop-api-v2.md。成功统一 { ok:true, ... }；失败由 jsonFetch 附带
 * status / path / payload（含 error、expected、got 等 detail）。
 */
const loop = (path, opts) => jsonFetch(`${API_BASE}/loop${path}`, opts)
const loopPost = (path, body) => loop(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
})
const loopPatch = (path, body) => loop(path, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
})
const qs = (params = {}) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') q.set(k, String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

/* 概览 / 批次 */
export const loopOverview = () => loop('/overview')
export const loopBatches = (query = '') => loop(`/batches${query}`)
export const loopBatch = (id) => loop(`/batches/${encodeURIComponent(id)}`)
export const loopRetryBatch = (id) => loopPost(`/batches/${encodeURIComponent(id)}/retry`)

/* 导入 */
export const loopPreview = (body) => loopPost('/preview', body)
export const loopImport = (body) => loopPost('/import', body)
export const loopImports = (query = '') => loop(`/imports${query}`)
export const loopImportDetail = (id) => loop(`/imports/${encodeURIComponent(id)}`)
export const loopArchiveImport = (id) => loopPost(`/imports/${encodeURIComponent(id)}/archive`)
export const loopExtract = (id, body = {}) => loopPost(`/import/${encodeURIComponent(id)}/extract`, body)

/* 原子记忆 */
export const loopMemories = (query = '') => loop(`/memories${query}`)
export const loopMemory = (id) => loop(`/memories/${encodeURIComponent(id)}`)
export const loopCorrect = (id, body) => loopPost(`/memories/${encodeURIComponent(id)}/correct`, body)
export const loopPatchMemory = (id, body) => loopPatch(`/memories/${encodeURIComponent(id)}`, body)
export const loopMemoryVersions = (id) => loop(`/memories/${encodeURIComponent(id)}/versions`)
export const loopMergeMemory = (id, body) => loopPost(`/memories/${encodeURIComponent(id)}/merge`, body)

/* 动态本体 */
export const loopOntology = () => loop('/ontology')
export const loopOntologyInstance = (id) => loop(`/ontology/instances/${encodeURIComponent(id)}`)
export const loopSetInstanceProp = (id, body) => loopPost(`/ontology/instances/${encodeURIComponent(id)}/props`, body)
export const loopSetInstanceRelation = (id, body) => loopPost(`/ontology/instances/${encodeURIComponent(id)}/relations`, body)
export const loopSetInstanceState = (id, body) => loopPost(`/ontology/instances/${encodeURIComponent(id)}/state`, body)
export const loopApproveProposal = (id) => loopPost(`/ontology/proposals/${encodeURIComponent(id)}/approve`)
export const loopRejectProposal = (id) => loopPost(`/ontology/proposals/${encodeURIComponent(id)}/reject`)

/* 规则 */
export const loopRules = (query = '') => loop(`/rules${query}`)
export const loopRule = (id) => loop(`/rules/${encodeURIComponent(id)}`)
export const loopRuleVersions = (id) => loop(`/rules/${encodeURIComponent(id)}/versions`)
export const loopRuleConflicts = () => loop('/rules/conflicts')
export const loopApproveRule = (id) => loopPost(`/rules/${encodeURIComponent(id)}/approve`)
export const loopPauseRule = (id) => loopPost(`/rules/${encodeURIComponent(id)}/pause`)
export const loopResumeRule = (id) => loopPost(`/rules/${encodeURIComponent(id)}/resume`)
export const loopArchiveRule = (id) => loopPost(`/rules/${encodeURIComponent(id)}/archive`)
export const loopPatchRule = (id, body) => loopPatch(`/rules/${encodeURIComponent(id)}`, body)
export const loopSupersedeRule = (id, body) => loopPost(`/rules/${encodeURIComponent(id)}/supersede`, body)
export const loopSimulateRule = (id, context) => loopPost(`/rules/${encodeURIComponent(id)}/simulate`, { context })

/* 上下文 / 反馈 / 运行 */
export const loopContext = (body) => loopPost('/context', body)
export const loopJobs = (query = '') => loop(`/jobs${query}`)
export const loopJob = (id) => loop(`/jobs/${encodeURIComponent(id)}`)
export const loopRetryJob = (id) => loopPost(`/jobs/${encodeURIComponent(id)}/retry`)
export const loopCancelJob = (id) => loopPost(`/jobs/${encodeURIComponent(id)}/cancel`)
export const loopOntologyVersions = () => loop('/ontology/versions')
export const loopOntologyVersionDiff = (id) => loop(`/ontology/versions/${encodeURIComponent(id)}/diff`)
export const loopRollbackOntology = (id, body) => loopPost(`/ontology/versions/${encodeURIComponent(id)}/rollback`, body)
export const loopResolveConflict = (key, body) => loopPost(`/rules/conflicts/${encodeURIComponent(key)}/resolve`, body)
export const loopEmbeddingStatus = (query = '') => loop(`/embeddings/status${query}`)
export const loopReindexEmbeddings = (body = {}) => loopPost('/embeddings/reindex', body)
export const loopActionCheck = (body) => loopPost('/actions/check', body)
export const loopActions = (query = '') => loop(`/actions${query}`)
export const loopFeedback = (body) => loopPost('/feedback', body)
export const loopFeedbackList = (query = '') => loop(`/feedback${query}`)
export const loopRuns = (query = '') => loop(`/runs${query}`)
export const loopAudit = (query = '') => loop(`/audit${query}`)

/* Skill 候选 */
export const loopSkills = (query = '') => loop(`/skills${query}`)
export const loopDeriveSkills = (body) => loopPost('/skills/derive', body)
export const loopPatchSkill = (id, body) => loopPatch(`/skills/${encodeURIComponent(id)}`, body)
export const loopExportSkill = (id) => loopPost(`/skills/${encodeURIComponent(id)}/export`)
export const loopRejectSkill = (id) => loopPost(`/skills/${encodeURIComponent(id)}/reject`)

/* 图 / 搜索 */
export const loopGraph = (query = '') => loop(`/graph${query}`)
export const loopSearch = (query = '') => loop(`/search${query}`)

