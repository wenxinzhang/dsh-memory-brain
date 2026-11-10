/**
 * 星河大脑 · 闭环运行时（host 半边）
 *
 * 独立 SQLite 存储（默认 <root>/data/loop.db），不修改 xiaojiu_brain 的库。
 * 覆盖：对话导入 → 原子记忆 → 本体映射 → 规则候选/生效 → 上下文 → 反馈。
 *
 * 模型调用沿用 rulesEndpoint/rulesModel（OpenAI 兼容）。模型不可用时只保存原文，
 * 不伪造提取结果；演示/测试数据使用显式的 fixture 来源。
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const TYPES = ['fact', 'preference', 'constraint', 'decision', 'event', 'todo', 'method']
const TYPE_LABEL = { fact: '事实', preference: '偏好', constraint: '约束', decision: '决策', event: '事件', todo: '待办', method: '方法' }
const STRENGTHS = ['must', 'must_not', 'prefer', 'suggest']
const RULE_CATEGORIES = ['business_constraint', 'personal_preference', 'workflow', 'data_validation', 'state_transition', 'permission']
const RULE_CATEGORIES_LABEL = { business_constraint: '业务约束', personal_preference: '个人偏好', workflow: '工作流', data_validation: '数据校验', state_transition: '状态转换', permission: '权限/前置条件' }
const SCOPES = ['personal', 'project', 'task', 'artifact', 'domain']
const SOURCE_CATEGORIES = ['user_statement', 'model_suggestion', 'user_confirmation', 'tool_result', 'reference', 'system_inference', 'fixture']
const STATUSES = ['proposed', 'needs_confirmation', 'confirmed', 'superseded', 'conflict', 'archived', 'deleted']

/* v2：抽取协议版本、权限/优先级、单位换算与单用户边界。 */
const PROMPT_VERSION = 'extract-v4'
const RULE_SCHEMA_VERSION = 2
const OWNER_DEFAULT = 'local-user'
const GOVERNANCE = ['candidate', 'active', 'paused', 'superseded', 'expired']
const AUTHORITY_RANK = {
  current_instruction: 6,
  task_constraint: 5,
  project_rule: 4,
  domain_rule: 3,
  personal_preference: 2,
  model_suggestion: 1,
  imported_unconfirmed: 0,
}
const AUTHORITY_LABEL = {
  current_instruction: '当前明确指令',
  task_constraint: '当前任务/产物约束',
  project_rule: '当前项目已确认规则',
  domain_rule: '领域规则',
  personal_preference: '个人长期偏好',
  model_suggestion: '模型推断候选',
  imported_unconfirmed: '未确认导入',
}
const SOURCE_AUTHORITY = {
  user_confirmation: 'current_instruction',
  user_statement: 'project_rule',
  reference: 'domain_rule',
  tool_result: 'task_constraint',
  system_inference: 'model_suggestion',
  fixture: 'model_suggestion',
  model_suggestion: 'model_suggestion',
}
/** 可转换单位（键为「来源单位→目标单位」，factor 乘到来源值上得到目标值）。 */
const UNIT_CONVERSIONS = {
  'kg/d': { to: 't/d', factor: 0.001 },
  't/d': { to: 'kg/d', factor: 1000 },
  'bbl/d': { to: 't/d', factor: 0.1364 },
  'm': { to: 'km', factor: 0.001 },
  'km': { to: 'm', factor: 1000 },
  'kPa': { to: 'MPa', factor: 0.001 },
  'MPa': { to: 'kPa', factor: 1000 },
}
const SKILL_STATUSES = ['candidate', 'edited', 'exported', 'rejected']

/* MARKER-REAPPLY */
const json = (v, fallback = null) => { try { return v == null ? fallback : JSON.parse(v) } catch { return fallback } }
const text = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
const now = () => new Date().toISOString()
const uid = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

function sendJson(res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.length), 'Cache-Control': 'no-store' })
  res.end(body)
}
function sendError(res, status, error, extra = {}) { sendJson(res, { ok: false, error, ...extra }, status) }

/* ------------------------------------------------------------------ 解析 */

const ROLE_ALIASES = new Map([
  ['user', 'user'], ['用户', 'user'], ['我', 'user'], ['human', 'user'], ['提问', 'user'],
  ['assistant', 'assistant'], ['ai', 'assistant'], ['助手', 'assistant'], ['模型', 'assistant'], ['回答', 'assistant'],
  ['system', 'system'], ['系统', 'system'], ['tool', 'tool'], ['工具', 'tool'],
])

/** 解析角色标记文本。无法识别角色时保留为 unknown 并给出警告，不猜测发言者。 */
export function parseTextConversation(input) {
  const raw = String(input ?? '').replace(/\r\n/g, '\n')
  const lines = raw.split('\n')
  const messages = []
  let current = null
  const warnings = []
  const roleRe = /^\s*(?:\[([^\]]{1,40})\]\s*)?(user|用户|我|human|assistant|ai|助手|模型|回答|system|系统|tool|工具|提问)\s*[:：]\s?(.*)$/i
  const timeRe = /^\s*\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)\]\s*/
  for (const line of lines) {
    const m = line.match(roleRe)
    if (m) {
      if (current) messages.push(current)
      const role = ROLE_ALIASES.get(m[2].toLowerCase()) || 'unknown'
      let body = m[3] ?? ''
      let originalTime = m[1] && /\d{4}-\d{2}-\d{2}/.test(m[1]) ? parseTime(m[1]) : null
      const tm = body.match(timeRe)
      if (tm) { originalTime = parseTime(tm[1]); body = body.slice(tm[0].length) }
      current = { role, content: body, originalTime, warnings: [] }
    } else if (current) {
      current.content += (current.content ? '\n' : '') + line
    } else if (line.trim()) {
      current = { role: 'unknown', content: line, originalTime: null, warnings: [] }
    }
  }
  if (current) messages.push(current)
  for (const m of messages) {
    m.content = String(m.content).trim()
    if (!m.content) m.warnings.push('空消息')
    if (m.role === 'unknown') { m.warnings.push('角色无法识别，请预览时修正') }
  }
  const nonEmpty = messages.filter((m) => m.content)
  if (!nonEmpty.length) throw new Error('没有可导入的消息')
  if (nonEmpty.every((m) => m.role === 'unknown')) warnings.push('未识别到角色标记；已按单条未知消息预览')
  return { format: 'text', messages: nonEmpty, warnings }
}

/** 兼容常见 JSON：数组、{messages}、{conversation:{messages}}、ChatGPT mapping 线性分支。 */
export function parseJsonConversation(input) {
  let obj
  try { obj = typeof input === 'string' ? JSON.parse(input) : input } catch (e) { throw new Error(`JSON 解析失败：${e.message}`) }
  let arr = null
  if (Array.isArray(obj)) arr = obj
  else if (Array.isArray(obj.messages)) arr = obj.messages
  else if (Array.isArray(obj.conversation?.messages)) arr = obj.conversation.messages
  else if (obj.mapping && typeof obj.mapping === 'object') {
    // Follow one branch, preserving ancestry rather than mixing regenerated answers.
    const mapping = obj.mapping
    const leaf = obj.current_node || Object.keys(mapping).filter(id => mapping[id]?.message)
      .sort((a, b) => (mapping[a].message.create_time ?? 0) - (mapping[b].message.create_time ?? 0)).at(-1)
    const branch = []; const seen = new Set()
    for (let id = leaf; id && mapping[id] && !seen.has(id); id = mapping[id].parent) {
      seen.add(id)
      if (mapping[id].message) branch.push({ ...mapping[id].message, parent_id: mapping[id].parent })
    }
    arr = branch.reverse()
  } else if (typeof obj.content === 'string') arr = [{ role: 'user', content: obj.content }]
  if (!arr) throw new Error('JSON 中没有找到 messages 数组')
  const messages = arr.map((m, i) => {
    const roleRaw = m.role ?? m.author?.role ?? m.from ?? m.speaker ?? ''
    const role = /^(user|human)$/i.test(roleRaw) ? 'user' : /^(assistant|ai|model|bot)$/i.test(roleRaw) ? 'assistant' : /^system$/i.test(roleRaw) ? 'system' : /^tool$/i.test(roleRaw) ? 'tool' : 'unknown'
    let content = m.content ?? m.text ?? m.parts?.join?.('\n') ?? m.message?.content ?? ''
    if (content && !Array.isArray(content) && typeof content === 'object') content = content.parts ?? content.text ?? ''
    if (Array.isArray(content)) content = content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('\n')
    const t = m.create_time ?? m.timestamp ?? m.time ?? m.original_time
    const atts = Array.isArray(m.attachments) ? m.attachments : Array.isArray(m.attachment) ? m.attachment : []
    return {
      role, content: String(content ?? '').trim(), originalTime: parseTime(t), externalId: m.id ?? m.message_id ?? null,
      parentId: m.parent_id ?? m.parentId ?? null, timezone: m.timezone ?? m.tz ?? null,
      attachments: atts.map((a) => ({ name: text(a?.name || a?.filename || '附件'), size: Number(a?.size) || null, type: text(a?.type || a?.mimeType) || null, parsed: false })),
      warnings: role === 'unknown' ? ['角色无法识别，请预览时修正'] : [],
    }
  }).filter((m) => m.content)
  if (!messages.length) throw new Error('JSON 中没有可导入的消息')
  return { format: 'json', messages, warnings: messages.some((m) => m.role === 'unknown') ? ['存在无法识别的角色'] : [] }
}

/** 导入文件校验：类型、大小、编码特征。返回规范化错误，不猜测文件内容。 */
export const IMPORT_EXTENSIONS = ['.json', '.md', '.markdown', '.txt']
export function validateImportFile({ filename, text, sizeBytes, mimeType } = {}) {
  const errors = []
  const warnings = []
  const name = String(filename || '').trim()
  if (name) {
    const dot = name.lastIndexOf('.')
    const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
    if (!IMPORT_EXTENSIONS.includes(ext)) errors.push(`不支持的文件类型：${ext || '无扩展名'}（仅支持 ${IMPORT_EXTENSIONS.join(' / ')}）`)
    if (mimeType && !/^(text\/|application\/(json|octet-stream)$)/i.test(mimeType)) warnings.push(`MIME 类型为 ${mimeType}，已按文本尝试解析`)
  }
  const size = Number(sizeBytes ?? Buffer.byteLength(String(text ?? ''), 'utf8'))
  if (Number.isFinite(size) && size > 20_000_000) errors.push('文件超过 20MB 限制')
  const raw = String(text ?? '')
  if (/\u0000/.test(raw)) errors.push('文件包含 NUL 字节，可能是二进制文件，已拒绝按文本导入')
  if (raw.length && !/[\n\r\u4e00-\u9fa5A-Za-z0-9]/.test(raw)) warnings.push('内容中没有可识别的文本字符，请检查编码')
  return { ok: errors.length === 0, errors, warnings, size, ext: name ? name.slice(name.lastIndexOf('.')).toLowerCase() : '' }
}

export function parseConversation(input, format = 'auto') {
  const raw = String(input ?? '')
  if (!raw.trim()) throw new Error('导入内容为空')
  if (raw.length > 20_000_000) throw new Error('文件超过 20MB 限制')
  if (/\u0000/.test(raw)) throw new Error('内容包含 NUL 字节，拒绝按文本导入')
  const trimmed = raw.trim()
  let result
  if (format === 'json' || (format === 'auto' && (trimmed.startsWith('{') || trimmed.startsWith('[')))) {
    result = parseJsonConversation(trimmed)
  } else {
    result = parseTextConversation(raw)
  }
  return { ...result, raw, hash: sha(raw), size: Buffer.byteLength(raw, 'utf8') }
}

/** 把预览里的角色修正应用到解析结果（index 为 1-based）。 */
export function applyRoleOverrides(parsed, overrides = {}) {
  const VALID = ['user', 'assistant', 'system', 'tool', 'unknown']
  const applied = []
  for (const [key, role] of Object.entries(overrides || {})) {
    const i = Number(key) - 1
    if (!Number.isInteger(i) || i < 0 || i >= parsed.messages.length) continue
    if (!VALID.includes(role)) continue
    parsed.messages[i].role = role
    parsed.messages[i].warnings = (parsed.messages[i].warnings || []).filter((w) => !/角色无法识别/.test(w))
    applied.push({ index: i + 1, role })
  }
  parsed.warnings = (parsed.warnings || []).filter((w) => !applied.length || !/角色/.test(w))
  parsed.roleOverrides = Object.fromEntries(applied.map((x) => [String(x.index), x.role]))
  return applied
}

function parseTime(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') {
    const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : v
    const d = new Date(ms); return Number.isFinite(d.getTime()) ? d.toISOString() : null
  }
  const s = String(v).trim()
  if (!s) return null
  const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

/* ------------------------------------------------------------------ 条件表达式 */

export function validateCondition(node, allowedPaths = null) {
  const errors = []
  if (!node || typeof node !== 'object' || Array.isArray(node)) return ['条件必须是对象']
  if (typeof node.op === 'string') {
    const op = node.op
    if (op === 'and' || op === 'or') {
      if (!Array.isArray(node.args) || !node.args.length) errors.push(`${op} 需要非空 args`)
      else node.args.forEach((a, i) => { for (const e of validateCondition(a, allowedPaths)) errors.push(`args[${i}]: ${e}`) })
      return errors
    }
    if (op === 'not') {
      if (!node.arg) errors.push('not 需要 arg')
      else for (const e of validateCondition(node.arg, allowedPaths)) errors.push(`arg: ${e}`)
      return errors
    }
    if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'exists'].includes(op)) return [`不支持的操作符：${op}`]
    if (typeof node.path !== 'string' || !node.path.trim()) errors.push('条件缺少 path')
    if (allowedPaths && node.path && !allowedPaths.has(node.path)) errors.push(`未知属性：${node.path}`)
    if (op !== 'exists' && !('value' in node)) errors.push(`${op} 缺少 value`)
    if (op === 'in' && !Array.isArray(node.value)) errors.push('in 的 value 必须是数组')
    return errors
  }
  return ['条件必须是 {op,...} 对象']
}

export function evaluateCondition(node, context) {
  if (!node || typeof node !== 'object') return { value: false, unknown: false, reason: '空条件' }
  if (node.op === 'and' || node.op === 'or') {
    const args = Array.isArray(node.args) ? node.args : []
    const results = args.map((a) => evaluateCondition(a, context))
    const unknown = results.some((r) => r.unknown)
    const values = results.map((r) => r.value)
    const value = node.op === 'and' ? values.every(Boolean) : values.some(Boolean)
    return { value, unknown: unknown && !(node.op === 'or' && value), reason: `${node.op}(${results.map((r) => r.reason).join('; ')})` }
  }
  if (node.op === 'not') {
    const r = evaluateCondition(node.arg, context)
    return { value: !r.value, unknown: r.unknown, reason: `not(${r.reason})` }
  }
  const found = getPath(context, node.path)
  if (!found.exists) return { value: false, unknown: true, reason: `缺少属性 ${node.path}` }
  const actual = found.value
  if (node.op === 'exists') return { value: actual != null, unknown: false, reason: `${node.path} exists` }
  const expected = node.value
  let ok = false
  try {
    if (node.op === 'eq') ok = actual === expected
    else if (node.op === 'ne') ok = actual !== expected
    else if (node.op === 'gt') ok = Number(actual) > Number(expected)
    else if (node.op === 'gte') ok = Number(actual) >= Number(expected)
    else if (node.op === 'lt') ok = Number(actual) < Number(expected)
    else if (node.op === 'lte') ok = Number(actual) <= Number(expected)
    else if (node.op === 'in') ok = Array.isArray(expected) && expected.includes(actual)
  } catch { return { value: false, unknown: true, reason: `属性类型不匹配 ${node.path}` } }
  return { value: ok, unknown: false, reason: `${node.path} ${node.op} ${JSON.stringify(expected)}` }
}
function getPath(obj, path) {
  const parts = String(path || '').split('.').filter(Boolean)
  let cur = obj
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return { exists: false }
    cur = cur[part]
  }
  return { exists: true, value: cur }
}

/* ------------------------------------------------------------------ 本体/规则辅助 */

export function validateTransition(transitions, from, to) {
  if (!to) return { ok: false, reason: '缺少目标状态' }
  if (from && from === to) return { ok: true, reason: '状态未变化' }
  const list = Array.isArray(transitions) ? transitions : []
  const allowed = list.some((t) => (Array.isArray(t) ? t[0] === (from || null) && t[1] === to : t.from === from && t.to === to))
  return { ok: allowed, reason: allowed ? '允许的状态转换' : `非法状态转换：${from || '未设置'} → ${to}` }
}

/** “可以/继续/好的”这类短回复只确认可明确指向的对象；否则待确认。 */
export function classifyConfirmation(content, candidates = []) {
  const s = text(content)
  const short = /^(可以|好的?|行|继续|就这样|同意|没问题|ok|okay|yes)[。.!！]?$/i.test(s)
  if (!short) return { kind: 'none' }
  const distinct = new Set((candidates || []).map((c) => c && (c.id ?? c.text)))
  if (distinct.size === 1) return { kind: 'confirmed', target: candidates[0] }
  return { kind: 'ambiguous', reason: distinct.size ? '存在多个候选，无法确定指向' : '没有可确认的候选对象' }
}

/** 规则权威性：来源身份 + 范围 + 确认状态共同决定；导入文本不能自称高优先级。 */
export function ruleAuthority(rule = {}) {
  const scope = rule.scope_type
  const src = SOURCE_AUTHORITY[rule.source_category] || 'model_suggestion'
  const confirmed = ['active', 'paused', 'superseded', 'expired'].includes(rule.governance_status) || rule.confirmation === 'confirmed' || rule.confirmation === 'human_edited'
  let key
  if (rule.source_category === 'model_suggestion' || rule.confirmation === 'candidate') key = 'model_suggestion'
  else if (rule.current_instruction) key = 'current_instruction'
  else if (scope === 'task' || scope === 'artifact') key = confirmed ? 'task_constraint' : 'model_suggestion'
  else if (scope === 'project') key = confirmed ? 'project_rule' : 'model_suggestion'
  else if (scope === 'domain') key = confirmed ? 'domain_rule' : 'model_suggestion'
  else if (scope === 'personal') key = confirmed ? 'personal_preference' : 'model_suggestion'
  else key = src === 'model_suggestion' ? 'model_suggestion' : 'project_rule'
  return { key, rank: AUTHORITY_RANK[key] ?? 0, label: AUTHORITY_LABEL[key] || key }
}

export function rankRules(rules) {
  const scopeRank = { task: 6, artifact: 5, project: 4, domain: 3, personal: 2 }
  const strengthRank = { must: 4, must_not: 4, prefer: 2, suggest: 1 }
  return [...rules]
    .map((r) => ({ ...r, authority: r.authority || ruleAuthority(r) }))
    .sort((a, b) => (b.authority?.rank ?? 0) - (a.authority?.rank ?? 0)
      || (scopeRank[b.scope_type] ?? 0) - (scopeRank[a.scope_type] ?? 0)
      || (strengthRank[b.strength] ?? 0) - (strengthRank[a.strength] ?? 0)
      || String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
}

/* ------------------------------------------------------------------ 数据库 */

const MIGRATIONS = [
  {
    version: 1,
    sql: `
    CREATE TABLE IF NOT EXISTS loop_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS loop_sources (
      id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'local',
      external_conversation_id TEXT, title TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT 'local-user',
      project TEXT, task TEXT, file_name TEXT, content_hash TEXT NOT NULL, raw_text TEXT,
      imported_at TEXT NOT NULL, extraction_status TEXT NOT NULL DEFAULT 'raw_saved',
      extraction_error TEXT NOT NULL DEFAULT '', warnings_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_loop_source_hash ON loop_sources(source_kind, content_hash, file_name);
    CREATE TABLE IF NOT EXISTS loop_messages (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_message_id TEXT, parent_id TEXT,
      role TEXT NOT NULL, ordinal INTEGER NOT NULL, content TEXT NOT NULL, original_time TEXT,
      timezone TEXT, content_hash TEXT NOT NULL, attachment_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
      UNIQUE(source_id, external_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_loop_msg_source ON loop_messages(source_id, ordinal);
    CREATE TABLE IF NOT EXISTS loop_batches (
      id TEXT PRIMARY KEY, source_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_memories (
      id TEXT PRIMARY KEY, source_id TEXT, type TEXT NOT NULL, text TEXT NOT NULL,
      subject TEXT, predicate TEXT, object_value TEXT, normalized_key TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'personal', scope_id TEXT,
      owner TEXT NOT NULL DEFAULT 'local-user', project TEXT, task TEXT,
      source_category TEXT NOT NULL, confirmation TEXT NOT NULL, certainty REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL, event_time TEXT, valid_from TEXT, valid_to TEXT,
      recorded_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, supersedes_id TEXT,
      conflict_group TEXT, ontology_instance_id TEXT, confidence REAL NOT NULL DEFAULT 0.5,
      sensitive INTEGER NOT NULL DEFAULT 0, metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loop_mem_status ON loop_memories(status, type);
    CREATE INDEX IF NOT EXISTS idx_loop_mem_key ON loop_memories(normalized_key);
    CREATE TABLE IF NOT EXISTS loop_memory_evidence (
      memory_id TEXT NOT NULL, message_id TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '',
      UNIQUE(memory_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS loop_ontology_types (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_ontology_props (
      id TEXT PRIMARY KEY, type_id TEXT NOT NULL, name TEXT NOT NULL, datatype TEXT NOT NULL DEFAULT 'string',
      unit TEXT, enum_json TEXT NOT NULL DEFAULT '[]', required INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_ontology_relations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, from_type TEXT NOT NULL, to_type TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_ontology_states (
      id TEXT PRIMARY KEY, type_id TEXT NOT NULL, name TEXT NOT NULL, transitions_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_ontology_instances (
      id TEXT PRIMARY KEY, type_id TEXT NOT NULL, name TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]',
      owner TEXT NOT NULL DEFAULT 'local-user', project TEXT, status TEXT NOT NULL DEFAULT 'active',
      candidate INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_inst_name ON loop_ontology_instances(type_id, name, owner, IFNULL(project,''));
    CREATE TABLE IF NOT EXISTS loop_instance_props (
      instance_id TEXT NOT NULL, prop_id TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(instance_id, prop_id)
    );
    CREATE TABLE IF NOT EXISTS loop_instance_relations (
      id TEXT PRIMARY KEY, from_id TEXT NOT NULL, relation_id TEXT NOT NULL, to_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_state_history (
      id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, state TEXT NOT NULL, from_state TEXT,
      reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_ontology_proposals (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'candidate',
      evidence TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_rules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
      scope_type TEXT NOT NULL, scope_id TEXT, owner TEXT NOT NULL DEFAULT 'local-user', project TEXT, task TEXT,
      object_type TEXT, object_id TEXT, trigger_event TEXT, conditions_json TEXT NOT NULL DEFAULT '{}',
      actions_json TEXT NOT NULL DEFAULT '[]', strength TEXT NOT NULL, exceptions_json TEXT NOT NULL DEFAULT '[]',
      acceptance TEXT NOT NULL DEFAULT '', source_category TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.5, confirmation TEXT NOT NULL DEFAULT 'candidate',
      valid_from TEXT, valid_to TEXT, governance_status TEXT NOT NULL DEFAULT 'candidate', version INTEGER NOT NULL DEFAULT 1,
      supersedes_id TEXT, structure_status TEXT NOT NULL DEFAULT 'structured',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_rule_versions (
      id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_rule_evals (
      id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, context_json TEXT NOT NULL, result TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_runs (
      id TEXT PRIMARY KEY, request_json TEXT NOT NULL, context_json TEXT NOT NULL, budget INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_feedback (
      id TEXT PRIMARY KEY, run_id TEXT, outcome TEXT NOT NULL, feedback TEXT NOT NULL DEFAULT '',
      correction_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_audit (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL DEFAULT 'local-user', action TEXT NOT NULL, entity TEXT NOT NULL,
      entity_id TEXT, detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    `,
  },
  {
    version: 2,
    sql: `
    ALTER TABLE loop_sources ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE loop_sources ADD COLUMN role_overrides_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE loop_sources ADD COLUMN archived_at TEXT;
    ALTER TABLE loop_memories ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE loop_memories ADD COLUMN extraction_run_id TEXT;
    ALTER TABLE loop_memories ADD COLUMN parent_memory_id TEXT;
    ALTER TABLE loop_memories ADD COLUMN sensitive_reason TEXT;
    ALTER TABLE loop_rules ADD COLUMN structure_errors_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE loop_rules ADD COLUMN feedback_id TEXT;
    ALTER TABLE loop_batches ADD COLUMN detail_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE loop_batches ADD COLUMN source_hash TEXT NOT NULL DEFAULT '';
    ALTER TABLE loop_batches ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
    CREATE INDEX IF NOT EXISTS idx_loop_mem_owner ON loop_memories(owner, status, type);
    CREATE INDEX IF NOT EXISTS idx_loop_rule_owner ON loop_rules(owner, governance_status);
    CREATE TABLE IF NOT EXISTS loop_memory_versions (
      id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, version INTEGER NOT NULL,
      text TEXT NOT NULL, object_value TEXT, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loop_memver ON loop_memory_versions(memory_id, version);
    CREATE TABLE IF NOT EXISTS loop_instance_prop_history (
      id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, prop_id TEXT NOT NULL, value_json TEXT NOT NULL,
      unit TEXT, source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loop_instprop ON loop_instance_prop_history(instance_id, created_at);
    CREATE TABLE IF NOT EXISTS loop_extraction_runs (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, batch_id TEXT, chunk_index INTEGER NOT NULL,
      chunk_key TEXT NOT NULL, content_hash TEXT NOT NULL, prompt_version TEXT NOT NULL, schema_version INTEGER NOT NULL,
      model TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
      memory_count INTEGER NOT NULL DEFAULT 0, rule_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      UNIQUE(source_id, chunk_key)
    );
    CREATE INDEX IF NOT EXISTS idx_loop_extract_batch ON loop_extraction_runs(batch_id);
    CREATE TABLE IF NOT EXISTS loop_skill_candidates (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL DEFAULT 'local-user', project TEXT, name TEXT NOT NULL,
      scenario TEXT NOT NULL DEFAULT '', inputs_json TEXT NOT NULL DEFAULT '[]', preconditions_json TEXT NOT NULL DEFAULT '[]',
      steps_json TEXT NOT NULL DEFAULT '[]', exceptions_json TEXT NOT NULL DEFAULT '[]', boundaries_json TEXT NOT NULL DEFAULT '[]',
      acceptance TEXT NOT NULL DEFAULT '', output_format TEXT NOT NULL DEFAULT '', evidence_json TEXT NOT NULL DEFAULT '[]',
      source_memory_ids_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'deterministic',
      status TEXT NOT NULL DEFAULT 'candidate', version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loop_skill_owner ON loop_skill_candidates(owner, status);
    `,
  },
  {
    version: 3,
    sql: `
    CREATE TABLE IF NOT EXISTS loop_action_checks (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL DEFAULT 'local-user', project TEXT, task TEXT,
      object_id TEXT, object_name TEXT, run_id TEXT, rule_ids_json TEXT NOT NULL DEFAULT '[]',
      actions_json TEXT NOT NULL DEFAULT '[]', result TEXT NOT NULL, authorization TEXT NOT NULL DEFAULT 'not_granted',
      reason TEXT NOT NULL DEFAULT '', detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loop_action_owner ON loop_action_checks(owner, created_at);
    `,
  },
  {
    version: 4,
    sql: `
    CREATE TABLE IF NOT EXISTS loop_jobs (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL DEFAULT 'local-user', type TEXT NOT NULL, source_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued', progress_done INTEGER NOT NULL DEFAULT 0, progress_total INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
      lease_owner TEXT, lease_until TEXT, idempotency_key TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '', cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loop_jobs_queue ON loop_jobs(status, type, created_at);
    CREATE INDEX IF NOT EXISTS idx_loop_jobs_owner ON loop_jobs(owner, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_jobs_idem ON loop_jobs(idempotency_key) WHERE status IN ('queued','running');
    CREATE TABLE IF NOT EXISTS loop_ontology_versions (
      id TEXT PRIMARY KEY, version INTEGER NOT NULL, action TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      diff_json TEXT NOT NULL DEFAULT '{}', actor TEXT NOT NULL DEFAULT 'local-user', note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_ontver_version ON loop_ontology_versions(version);
    CREATE TABLE IF NOT EXISTS loop_ontology_change_log (
      id TEXT PRIMARY KEY, version_id TEXT, version INTEGER, action TEXT NOT NULL, change_set_json TEXT NOT NULL DEFAULT '{}',
      affected_types_json TEXT NOT NULL DEFAULT '[]', affected_instances_json TEXT NOT NULL DEFAULT '[]',
      affected_memories_json TEXT NOT NULL DEFAULT '[]', affected_rules_json TEXT NOT NULL DEFAULT '[]',
      operator TEXT NOT NULL DEFAULT 'local-user', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loop_ontlog_version ON loop_ontology_change_log(version);
    CREATE TABLE IF NOT EXISTS loop_rule_conflict_resolutions (
      id TEXT PRIMARY KEY, conflict_key TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'local-user',
      rule_a_id TEXT, rule_b_id TEXT, resolution TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT 'local-user', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loop_conflict_key ON loop_rule_conflict_resolutions(owner, conflict_key, created_at);
    CREATE TABLE IF NOT EXISTS loop_embeddings (
      memory_id TEXT NOT NULL, model TEXT NOT NULL, dimension INTEGER NOT NULL, vector_json TEXT NOT NULL,
      content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(memory_id, model)
    );
    CREATE INDEX IF NOT EXISTS idx_loop_emb_model ON loop_embeddings(model);
    `,
  },
]

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS loop_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const applied = new Set(db.prepare('SELECT version FROM loop_schema_migrations').all().map((r) => Number(r.version)))
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.prepare('INSERT INTO loop_schema_migrations(version, applied_at) VALUES(?,?)').run(m.version, now())
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
  }
}

function seedOntology(db) {
  const types = [
    ['project', '项目', '有明确目标和范围的工作集合'],
    ['task', '任务', '可执行、可验收的工作项'],
    ['document', '文档', '有版本和来源的文件/页面'],
    ['model', '模型', '被训练、评估或调用的模型'],
    ['device', '设备', '可观测、可操作的硬件或系统'],
    ['well', '油井', '示例业务对象：油井'],
    ['person', '人物', '对话中的用户或相关人物'],
    ['memory', '记忆', '沉淀后的原子记忆对象'],
  ]
  const insertType = db.prepare('INSERT OR IGNORE INTO loop_ontology_types(id,name,description,created_at) VALUES(?,?,?,?)')
  for (const t of types) insertType.run(...t, now())
  const props = [
    ['project', 'status', 'string', null, '[\'active\',\'paused\',"done",\'archived\']', 0],
    ['task', 'status', 'string', null, '["todo","doing","blocked","done"]', 0],
    ['task', 'priority', 'string', null, '["low","normal","high"]', 0],
    ['well', 'status', 'string', null, '["production","maintenance","offline"]', 1],
    ['well', 'location', 'string', null, '[]', 0],
    ['well', 'oil_rate', 'number', 't/d', '[]', 0],
    ['well', 'pressure', 'number', 'MPa', '[]', 0],
    ['well', 'depth', 'number', 'm', '[]', 0],
    ['model', 'status', 'string', null, '["candidate","active","retired"]', 0],
    ['document', 'status', 'string', null, '["draft","active","archived"]', 0],
  ]
  const insertProp = db.prepare('INSERT OR IGNORE INTO loop_ontology_props(id,type_id,name,datatype,unit,enum_json,required,created_at) VALUES(?,?,?,?,?,?,?,?)')
  for (const [type, name, datatype, unit, enumJson, required] of props) insertProp.run(`prop_${type}_${name}`, type, name, datatype, unit, enumJson, required, now())
  const relations = [
    ['rel_project_has_task', '包含任务', 'project', 'task'],
    ['rel_task_affects_document', '产出文档', 'task', 'document'],
    ['rel_well_belongs_project', '属于项目', 'well', 'project'],
    ['rel_model_used_by_task', '被任务使用', 'model', 'task'],
  ]
  const insertRel = db.prepare('INSERT OR IGNORE INTO loop_ontology_relations(id,name,from_type,to_type,created_at) VALUES(?,?,?,?,?)')
  for (const r of relations) insertRel.run(...r, now())
  const states = [
    ['well', 'production', [['production', 'maintenance'], ['maintenance', 'production'], ['production', 'offline'], ['offline', 'maintenance']]],
    ['task', 'todo', [['todo', 'doing'], ['doing', 'blocked'], ['doing', 'done'], ['blocked', 'doing']]],
    ['model', 'candidate', [['candidate', 'active'], ['active', 'retired']]],
  ]
  const insertState = db.prepare('INSERT OR IGNORE INTO loop_ontology_states(id,type_id,name,transitions_json,created_at) VALUES(?,?,?,?,?)')
  for (const [type, name, transitions] of states) insertState.run(`state_${type}_${name}`, type, name, JSON.stringify(transitions), now())
}

/* ------------------------------------------------------------------ 运行时 */

export function createLoopRuntime({ root, config = {}, logger } = {}) {
  const dbPath = resolve(String(config.loopDb || '').trim() || join(root, 'data', 'loop.db'))
  const endpoint = String(config.rulesEndpoint || 'http://127.0.0.1:8080/v1').replace(/\/+$/, '')
  const model = String(config.rulesModel || 'qwen3.8-flash-next')
  const apiKeyEnv = String(config.rulesApiKeyEnv || '').trim()
  const timeoutMs = Math.max(20_000, Math.min(300_000, Number(config.loopTimeoutMs) || 120_000))
  const maxContextChars = Math.max(2000, Math.min(200_000, Number(config.loopContextChars) || 20_000))
  const embedEndpoint = String(config.loopEmbedEndpoint ?? 'http://127.0.0.1:8781/v1/embeddings').trim()
  const embedModel = String(config.loopEmbedModel ?? 'bge-m3').trim()
  const embedApiKeyEnv = String(config.loopEmbedApiKeyEnv || '').trim()
  const embedEnabled = config.loopEmbedEnabled !== false && !!embedEndpoint && !!embedModel
  const workerEnabled = config.loopWorker !== false
  const workerIntervalMs = Math.max(40, Math.min(60_000, Number(config.loopWorkerIntervalMs) || 1200))
  const jobLeaseMs = Math.max(10_000, Math.min(30 * 60_000, Number(config.loopJobLeaseMs) || 5 * 60_000))
  const jobMaxAttempts = Math.max(1, Math.min(10, Number(config.loopJobMaxAttempts) || 3))
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  migrate(db)
  seedOntology(db)

  const audit = (action, entity, entityId, detail = {}, actor = 'local-user') => {
    db.prepare('INSERT INTO loop_audit(id,actor,action,entity,entity_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(uid('aud'), actor, action, entity, entityId ?? null, JSON.stringify(detail), now())
  }
  const tx = (fn) => {
    db.exec('BEGIN')
    try { const v = fn(); db.exec('COMMIT'); return v } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  const getSource = (id) => db.prepare('SELECT * FROM loop_sources WHERE id=?').get(id)
  const getMessages = (sourceId) => db.prepare('SELECT * FROM loop_messages WHERE source_id=? ORDER BY ordinal').all(sourceId)
  const ownerOf = (v) => text(v) || OWNER_DEFAULT
  const sourceJson = (r) => r && ({
    ...r,
    warnings: json(r.warnings_json, []),
    attachments: json(r.attachments_json, []).map((a) => ({ ...a, parsed: false, parsedLabel: '内容未解析' })),
    role_overrides: json(r.role_overrides_json, {}),
  })
  const batchJson = (r) => r && ({
    ...r,
    progress: r.total > 0 ? Math.min(1, (r.done + r.failed) / r.total) : 0,
    detail: json(r.detail_json, {}),
  })
  const memoryJson = (r) => r && ({
    ...r,
    protected: !!r.protected,
    metadata: json(r.metadata_json, {}),
    evidence: db.prepare(`SELECT e.message_id,e.quote,m.source_id,s.title AS source_title
      FROM loop_memory_evidence e LEFT JOIN loop_messages m ON m.id=e.message_id
      LEFT JOIN loop_sources s ON s.id=m.source_id AND s.owner=? WHERE e.memory_id=?`).all(r.owner,r.id),
    versions_count: db.prepare('SELECT COUNT(*) AS n FROM loop_memory_versions WHERE memory_id=?').get(r.id)?.n ?? 0,
  })
  const ruleJson = (r) => r && (() => {
    const authority = ruleAuthority(r)
    const nowIso = now()
    return {
      ...r,
      conditions: json(r.conditions_json, {}),
      actions: json(r.actions_json, []),
      exceptions: json(r.exceptions_json, []),
      evidence: json(r.evidence_json, []),
      structure_errors: json(r.structure_errors_json, []),
      authority: authority.key,
      authority_rank: authority.rank,
      authority_label: authority.label,
      versions_count: db.prepare('SELECT COUNT(*) AS n FROM loop_rule_versions WHERE rule_id=?').get(r.id)?.n ?? 0,
      expired: !!(r.valid_to && r.valid_to <= nowIso),
      not_yet: !!(r.valid_from && r.valid_from > nowIso),
    }
  })()
  const skillJson = (r) => r && ({
    ...r,
    inputs: json(r.inputs_json, []),
    preconditions: json(r.preconditions_json, []),
    steps: json(r.steps_json, []),
    exceptions: json(r.exceptions_json, []),
    boundaries: json(r.boundaries_json, []),
    evidence: json(r.evidence_json, []),
    source_memory_ids: json(r.source_memory_ids_json, []),
  })

  /** 记忆版本快照：人工修改、纠正、合并都写，旧记录不丢。 */
  function snapshotMemory(mem, note = '') {
    if (!mem) return
    db.prepare('INSERT INTO loop_memory_versions(id,memory_id,version,text,object_value,status,note,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(uid('mv'), mem.id, mem.version, mem.text, mem.object_value ?? null, mem.status, note, now())
  }

  function setMemoryProtected(id, note = '') {
    const row = db.prepare('SELECT * FROM loop_memories WHERE id=?').get(id)
    if (!row) return null
    snapshotMemory(row, note || '人工操作前快照')
    db.prepare('UPDATE loop_memories SET protected=1, updated_at=? WHERE id=?').run(now(), id)
    return db.prepare('SELECT * FROM loop_memories WHERE id=?').get(id)
  }


  let chatExtractionModel=null
  function capturedChatModel(source) {
    if(source.source_kind!=='dsh-auto')return null
    const jobs=db.prepare("SELECT payload_json FROM loop_jobs WHERE source_id=? AND type='extract' ORDER BY created_at DESC").all(source.id)
    return jobs.map(row=>json(row.payload_json,{}).model_selection).find(selection=>selection?.provider && selection?.model) || null
  }
  function setChatExtractionModel(caller) {
    chatExtractionModel=caller
    scheduleWorker(0)
    return ()=>{if(chatExtractionModel===caller)chatExtractionModel=null}
  }
  function callModel(messages,modelSelection=null) {
    if(modelSelection) {
      if(!chatExtractionModel)return Promise.reject(new Error('聊天抽取模型服务尚未就绪'))
      return Promise.resolve(chatExtractionModel(messages,modelSelection,{signal:AbortSignal.timeout(timeoutMs)}))
    }
    if (!endpoint || !model) return Promise.reject(Object.assign(new Error('模型未配置'), { code: 'MODEL_UNAVAILABLE' }))
    const headers = { 'Content-Type': 'application/json' }
    if (apiKeyEnv && process.env[apiKeyEnv]) headers.Authorization = `Bearer ${process.env[apiKeyEnv]}`
    return fetch(`${endpoint}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 6000, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`模型 HTTP ${res.status}`)
      const data = await res.json()
      return data?.choices?.[0]?.message?.content ?? ''
    })
  }
  function assertExtractionSource(source) {
    const current=getSource(source.id)
    if(!current || current.archived_at)throw Object.assign(new Error('抽取来源已归档或移除'),{code:'ARCHIVED'})
    if(current.content_hash!==source.content_hash)throw Object.assign(new Error('抽取来源已修改，迟到结果未提交'),{code:'SOURCE_CHANGED'})
  }

  function parseModelJson(raw) {
    let s = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    const a = s.indexOf('{'); const b = s.lastIndexOf('}')
    if (a < 0 || b <= a) throw new Error('模型没有返回 JSON')
    const obj = JSON.parse(s.slice(a, b + 1))
    if (!obj || typeof obj !== 'object') throw new Error('模型 JSON 不是对象')
    return {
      memories: Array.isArray(obj.memories) ? obj.memories : [],
      rules: Array.isArray(obj.rules) ? obj.rules : [],
      ontology_candidates: Array.isArray(obj.ontology_candidates) ? obj.ontology_candidates : [],
    }
  }

  const SYSTEM_PROMPT = [
    '你是星河大脑的“原子记忆 + 动态本体 + 业务规则”抽取器。只输出 JSON，不要输出解释。',
    '输入是一段带 [mN] 编号的对话。请抽取原子记忆、规则和本体候选。',
    '硬性边界：',
    '1. 一条记忆只表达一个主要命题；保留主语、对象、否定、数量、单位、条件和约束强度。',
    '2. 用户陈述才是用户事实；助手建议只能是 model_suggestion，不能自动变成用户事实或已确认决策。',
    '3. “可以/继续/好的”等短确认如果没有明确对象，needs_confirmation=true。',
    '4. 事实、计划、假设、问题、反事实要区分；局部“这次/当前页面”的要求不能升级为长期偏好。',
    '5. 每条记忆必须给出 evidence_message_ids；没有证据就不要输出。',
    '6. 规则只能在有明确来源和条件时输出；条件使用受限 JSON 表达式，不要写 SQL/脚本。',
    '7. 只保存值得后续复用的内容；寒暄、收到、重复复述、无长期价值的临时错误不要提取。没有适用内容时返回空数组，不能为凑数量编造记忆。',
    'JSON 结构：',
    '{"memories":[{"type":"fact|preference|constraint|decision|event|todo|method","text":"一句话",',
    '"subject":"","predicate":"","object":"","value":"","speaker":"user|assistant","source_category":"user_statement|model_suggestion|user_confirmation|tool_result|reference|system_inference",',
    '"scope_type":"personal|project|task|artifact|domain","scope_id":"","certainty":0.8,\'needs_confirmation\':false,',
    '"event_time":null,"evidence_message_ids":["m1"],"sensitive":false}],',
    '"rules":[{"name":"","description":"","category":"business_constraint|personal_preference|workflow|data_validation|state_transition|permission",',
    '"scope_type":"personal|project|task|artifact|domain","scope_id":"","strength":"must|must_not|prefer|suggest",',
    '"conditions":{"op":"eq","path":"well.status","value":"maintenance"},"actions":[{"type":"block","target":"optimization"}],',
    '"exceptions":[],"acceptance":"","evidence_message_ids":["m2"],"confidence":0.8}],',
    '"ontology_candidates":[{"kind":"type|property|relation","name":"","description":"","type":"","property":"","from":"","to":""}]}',
    '没有内容就返回空数组。',
  ].join('\n')

  /** 把对话切成带全局 [mN] 编号的抽取分块；跨块去重靠计划里的 chunk_key。 */
  function buildExtractionChunks(source, messages, maxChars = 6000, maxMessages = 12, modelKey = model) {
    const chunks = []
    let current = { text: '', map: new Map(), messages: [] }
    let used = 0
    for (const [i, m] of messages.entries()) {
      const tag = `m${i + 1}`
      const full = String(m.content)
      for (let offset = 0; offset < full.length; offset += 2500) {
      const fragment = full.slice(offset, offset + 2500)
      const line = `[${tag}] ${m.role}${full.length > 2500 ? ` [offset:${offset}]` : ''}: ${fragment}`
      if (current.messages.length && (used + line.length > maxChars || current.messages.length >= maxMessages)) {
        chunks.push(current)
        current = { text: '', map: new Map(), messages: [] }
        used = 0
      }
      current.text += (current.text ? '\n\n' : '') + line
      current.map.set(tag, { ...m, content: fragment })
      current.messages.push(m)
      used += line.length
      // Keep fragments of one message in separate chunks so evidence tags stay unambiguous.
      if (full.length > 2500) { chunks.push(current); current = { text: '', map: new Map(), messages: [] }; used = 0 }
      }
    }
    if (current.messages.length) chunks.push(current)
    return chunks.map((c, index) => ({
      index,
      text: c.text,
      map: c.map,
      messages: c.messages,
      key: sha([source.id, source.content_hash, c.text, PROMPT_VERSION, String(RULE_SCHEMA_VERSION), modelKey].join('|')),
    }))
  }

  function memoryScope(source, raw) {
    const st = SCOPES.includes(raw.scope_type) ? raw.scope_type : source.project ? 'project' : source.task ? 'task' : 'personal'
    return { scope_type: st, scope_id: raw.scope_id || (st === 'project' ? source.project : st === 'task' ? source.task : null) }
  }

  function normalizeMemory(raw, source, tagMap) {
    const type = TYPES.includes(raw.type) ? raw.type : 'fact'
    const content = text(raw.text)
    if (!content) return null
    const ids = Array.isArray(raw.evidence_message_ids) ? raw.evidence_message_ids : []
    const evidence = ids.map((tag) => tagMap.get(tag)).filter(Boolean)
    if (!evidence.length) return null
    const speaker = evidence.some((m) => m.role === 'user') ? 'user' : evidence.some((m) => m.role === 'assistant') ? 'assistant' : 'unknown'
    const userEvidence = evidence.every(m => m.role === 'user')
    const sourceCategory = userEvidence
      ? (SOURCE_CATEGORIES.includes(raw.source_category) ? raw.source_category : 'user_statement')
      : 'model_suggestion'
    const short = /^(可以|好的?|行|继续|就这样|同意|没问题|ok|okay|yes)[。.!！]?$/i.test(content)
    const ambiguous = userEvidence && (raw.needs_confirmation === true || (short && !text(raw.object) && !text(raw.value)))
    const confirmation = ambiguous ? 'ambiguous' : sourceCategory === 'user_statement' || sourceCategory === 'user_confirmation' ? 'stated' : 'suggested'
    // 模型建议永远不自动变成用户事实/已确认决策。
    const status = ambiguous ? 'needs_confirmation'
      : sourceCategory === 'user_statement' || sourceCategory === 'user_confirmation' ? 'confirmed' : 'proposed'
    const scope = memoryScope(source, raw)
    const subject = text(raw.subject) || null
    const predicate = text(raw.predicate) || null
    const objectValue = text(raw.object ?? raw.value) || null
    const key = sha([type, subject, predicate, objectValue, scope.scope_type, scope.scope_id, content].join('|'))
    return {
      type, text: content, subject, predicate, object_value: objectValue, key,
      ...scope, speaker, source_category: sourceCategory,
      confirmation, certainty: Number.isFinite(Number(raw.certainty)) ? Math.max(0, Math.min(1, Number(raw.certainty))) : 0.5,
      status, event_time: raw.event_time ? String(raw.event_time) : null,
      sensitive: raw.sensitive ? 1 : 0, sensitive_reason: raw.sensitive ? text(raw.sensitive_reason) || '模型标记敏感' : null,
      confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0.5,
      evidence,
    }
  }

  function saveMemory(m, source, runId = null) {
    const existing = db.prepare(`SELECT * FROM loop_memories WHERE normalized_key=? AND owner=? AND project IS ? AND task IS ? AND status IN ('confirmed','proposed','needs_confirmation','conflict') LIMIT 1`).get(m.key, source.owner || OWNER_DEFAULT, source.project ?? null, source.task ?? null)
    if (existing && existing.text === m.text) {
      // 重复内容只增加证据，不通过重复导入虚增可信度。
      for (const ev of m.evidence) db.prepare('INSERT OR IGNORE INTO loop_memory_evidence(memory_id,message_id,quote) VALUES(?,?,?)').run(existing.id, ev.id, ev.content.slice(0, 500))
      return { id: existing.id, duplicate: true, protected: !!existing.protected }
    }
    // 人工修订/纠正后的记忆受保护：重新拆解只能形成冲突候选，不能覆盖当前事实。
    const protectedRow = db.prepare(`SELECT * FROM loop_memories WHERE subject IS ? AND predicate IS ? AND protected=1 AND status IN ('confirmed','conflict') AND owner=? AND project IS ? AND task IS ? AND scope_type=? AND IFNULL(scope_id,'')=IFNULL(?,'') LIMIT 1`)
      .get(m.subject, m.predicate, source.owner || OWNER_DEFAULT, source.project ?? null, source.task ?? null, m.scope_type, m.scope_id)
    const conflict = protectedRow
      ? { ...protectedRow, protected_conflict: true }
      : db.prepare(`SELECT * FROM loop_memories WHERE subject IS ? AND predicate IS ? AND status='confirmed' AND owner=? AND project IS ? AND task IS ? AND scope_type=? AND IFNULL(scope_id,'')=IFNULL(?,'') AND IFNULL(object_value,'')<>IFNULL(?,'') LIMIT 1`)
        .get(m.subject, m.predicate, source.owner || OWNER_DEFAULT, source.project ?? null, source.task ?? null, m.scope_type, m.scope_id, m.object_value)
    const id = uid('mem')
    const status = conflict ? 'conflict' : m.status
    const conflictGroup = conflict ? (conflict.conflict_group || uid('cf')) : null
    const meta = { speaker: m.speaker, extraction_run_id: runId, protected_conflict: !!protectedRow, protected_id: protectedRow?.id || null }
    db.prepare(`INSERT INTO loop_memories(id,source_id,type,text,subject,predicate,object_value,normalized_key,scope_type,scope_id,owner,project,task,source_category,confirmation,certainty,status,event_time,valid_from,valid_to,recorded_at,version,supersedes_id,conflict_group,ontology_instance_id,confidence,sensitive,metadata_json,created_at,updated_at,protected,extraction_run_id,sensitive_reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, source.id, m.type, m.text, m.subject, m.predicate, m.object_value, m.key, m.scope_type, m.scope_id,
      source.owner || OWNER_DEFAULT, source.project, source.task, m.source_category, m.confirmation, m.certainty,
      status, m.event_time, null, null, now(), 1, null, conflictGroup, null, m.confidence, m.sensitive,
      JSON.stringify(meta), now(), now(), 0, runId, m.sensitive_reason)
    if (conflict) db.prepare('UPDATE loop_memories SET conflict_group=?, updated_at=? WHERE id=?').run(conflictGroup, now(), conflict.id)
    for (const ev of m.evidence) db.prepare('INSERT OR IGNORE INTO loop_memory_evidence(memory_id,message_id,quote) VALUES(?,?,?)').run(id, ev.id, ev.content.slice(0, 500))
    mapMemoryOntology(db.prepare('SELECT * FROM loop_memories WHERE id=?').get(id), source)
    return { id, duplicate: false, conflict: !!conflict, protected_conflict: !!protectedRow }
  }

  function mapMemoryOntology(mem, source) {
    if (mem.status !== 'confirmed') return
    const hay = `${mem.subject || ''} ${mem.text || ''}`
    let type = null; let name = null
    const well = hay.match(/\b([A-Z]{2,12}[_-]\d{1,5})\b/)
    if (well) { type = 'well'; name = well[1] }
    else {
      const cn = hay.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{1,24}(?:项目|任务|模型|设备|文档|井))/)
      if (cn) {
        name = cn[1]
        type = /项目/.test(name) ? 'project' : /任务/.test(name) ? 'task' : /模型/.test(name) ? 'model' : /设备/.test(name) ? 'device' : /文档/.test(name) ? 'document' : 'well'
      }
    }
    if (!type || !name) return null
    // 同名对象只在同一 owner + project 内匹配；跨用户/跨项目不自动合并。
    let inst = db.prepare(`SELECT * FROM loop_ontology_instances WHERE type_id=? AND name=? AND owner=? AND IFNULL(project,'')=IFNULL(?,'')`).get(type, name, source.owner || OWNER_DEFAULT, source.project)
    if (!inst) {
      const id = uid('inst')
      db.prepare('INSERT INTO loop_ontology_instances(id,type_id,name,owner,project,status,candidate,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, type, name, source.owner || OWNER_DEFAULT, source.project ?? null, 'active', 1, now(), now())
      inst = db.prepare('SELECT * FROM loop_ontology_instances WHERE id=?').get(id)
      audit('ontology.candidate', 'instance', id, { type, name })
    }
    db.prepare('UPDATE loop_memories SET ontology_instance_id=?, updated_at=? WHERE id=?').run(inst.id, now(), mem.id)
    // 只有事实/约束/事件可以推进当前状态；decision/todo 里的“恢复生产后”只是条件，不是当前状态。
    const evidenceText = db.prepare('SELECT quote FROM loop_memory_evidence WHERE memory_id=?').all(mem.id).map(e=>e.quote).join('\n')
    const uncertainState = /(?:尚未|没有|不在|未在|无需|取消|如果|若|计划|准备|将|待)[^。；;\n]{0,12}(?:检修|维护|生产|离线|停机)|\b(?:not|never|if|planned)\b[^.\n]{0,24}(?:maintenance|offline|production)/i.test(`${mem.text}\n${evidenceText}`)
    const stateEligible = ['fact', 'event'].includes(mem.type) && !uncertainState
    const state = !stateEligible ? null
      : /检修|维护|maintenance/i.test(mem.text) ? 'maintenance'
      : /已恢复生产|恢复生产完成|当前.*生产|处于生产/i.test(mem.text) ? 'production'
      : /离线|停机|offline/i.test(mem.text) ? 'offline' : null
    if (type === 'well' && state) {
      const current = db.prepare('SELECT state FROM loop_state_history WHERE instance_id=? ORDER BY created_at DESC LIMIT 1').get(inst.id)?.state || null
      if (current === state) return inst.id
      const transitions = json(db.prepare('SELECT transitions_json FROM loop_ontology_states WHERE type_id=? AND name=?').get(type, state)?.transitions_json, [])
      if (!current || transitions.some((t) => t[0] === current && t[1] === state)) {
        db.prepare('INSERT INTO loop_state_history(id,instance_id,state,from_state,reason,created_at) VALUES(?,?,?,?,?,?)').run(uid('st'), inst.id, state, current, mem.text.slice(0, 200), now())
        db.prepare('UPDATE loop_ontology_instances SET updated_at=? WHERE id=?').run(now(), inst.id)
      } else {
        db.prepare('INSERT INTO loop_ontology_proposals(id,kind,payload_json,status,evidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(uid('prop'), 'state_transition', JSON.stringify({ instance_id: inst.id, from: current, to: state, reason: '非法状态转换' }), 'rejected', mem.text.slice(0, 300), now(), now())
      }
    }
    return inst.id
  }

  function normalizeConditionForOntology(node, owner = null) {
    if (!node || typeof node !== 'object') return node
    if (node.op === 'and' || node.op === 'or') return { ...node, args: (node.args || []).map((a) => normalizeConditionForOntology(a, owner)) }
    if (node.op === 'not') return { ...node, arg: normalizeConditionForOntology(node.arg, owner) }
    if (typeof node.path !== 'string') return node
    const [head, ...rest] = node.path.split('.')
    const inst = owner
      ? db.prepare('SELECT type_id,name FROM loop_ontology_instances WHERE name=? AND owner=? LIMIT 1').get(head, owner)
      : db.prepare('SELECT type_id,name FROM loop_ontology_instances WHERE name=? LIMIT 1').get(head)
    if (!inst) return node
    const path = [inst.type_id, ...rest].join('.')
    const stateMap = { '检修': 'maintenance', '维护': 'maintenance', '生产': 'production', '投产': 'production', '离线': 'offline', '停机': 'offline' }
    const mapValue = (v) => (typeof v === 'string' && stateMap[v]) ? stateMap[v] : v
    if ('value' in node) return { ...node, path, value: Array.isArray(node.value) ? node.value.map(mapValue) : mapValue(node.value) }
    return { ...node, path }
  }

  /** 规则已指向具体对象时，把模型常用的泛化主语（asset/object/well）映射到该对象类型。 */
  function remapGenericConditionPaths(node, objectType) {
    if (!node || typeof node !== 'object' || !objectType) return node
    if (node.op === 'and' || node.op === 'or') return { ...node, args: (node.args || []).map((a) => remapGenericConditionPaths(a, objectType)) }
    if (node.op === 'not') return { ...node, arg: remapGenericConditionPaths(node.arg, objectType) }
    if (typeof node.path !== 'string') return node
    const [head, ...rest] = node.path.split('.')
    const typeExists = db.prepare('SELECT 1 AS x FROM loop_ontology_types WHERE id=?').get(head)
    const instExists = db.prepare('SELECT 1 AS x FROM loop_ontology_instances WHERE name=? OR id=?').get(head, head)
    if (typeExists || instExists) return node
    const prop = rest.join('.')
    if (prop && db.prepare('SELECT 1 AS x FROM loop_ontology_props WHERE type_id=? AND name=?').get(objectType, prop)) {
      return { ...node, path: `${objectType}.${prop}` }
    }
    return node
  }

  /** 校验条件里的属性路径能在本体定义中找到（type.property 或 instance.property）。 */
  function conditionPathErrors(conditions) {
    const errors = validateCondition(conditions)
    if (errors.length) return errors
    const types = new Set(db.prepare('SELECT id FROM loop_ontology_types').all().map((x) => x.id))
    const instances = new Map(db.prepare('SELECT name,type_id FROM loop_ontology_instances').all().map((x) => [x.name, x.type_id]))
    const propRows = db.prepare('SELECT type_id,name,datatype,enum_json FROM loop_ontology_props').all()
    const props = new Map(propRows.map((x) => [`${x.type_id}.${x.name}`, x]))
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (n.op === 'and' || n.op === 'or') return (n.args || []).forEach(walk)
      if (n.op === 'not') return walk(n.arg)
      if (typeof n.path !== 'string') return
      const [head, ...rest] = n.path.split('.')
      const type = types.has(head) ? head : instances.get(head)
      if (!type) { errors.push(`未知对象/类型：${head}`); return }
      const prop = rest.join('.')
      if (rest.length > 1) { errors.push(`属性路径过深：${n.path}`); return }
      if (!prop) return
      const def = props.get(`${type}.${prop}`)
      if (!def) { errors.push(`属性未在本体定义中：${head}.${prop}`); return }
      const enums = json(def.enum_json, [])
      if (enums.length && ['eq', 'ne', 'in'].includes(n.op)) {
        const vals = n.op === 'in' ? (Array.isArray(n.value) ? n.value : []) : [n.value]
        for (const v of vals) if (!enums.includes(v)) errors.push(`值不在枚举范围：${head}.${prop}=${JSON.stringify(v)}（允许 ${enums.join('/')}）`)
      }
      if (def.datatype === 'number' && ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'].includes(n.op)) {
        const vals = n.op === 'in' ? (Array.isArray(n.value) ? n.value : []) : [n.value]
        for (const v of vals) if (!Number.isFinite(Number(v))) errors.push(`属性类型不匹配：${head}.${prop} 需要数值`)
      }
    }
    walk(conditions)
    return errors
  }

  function saveRule(raw, source, tagMap, runId = null) {
    let scope = SCOPES.includes(raw.scope_type) ? raw.scope_type : source.project ? 'project' : 'personal'
    let scopeId = raw.scope_id || (scope === 'project' ? source.project : null)
    let objectType = null; let objectId = null
    // 规则指向具体业务对象时归为 artifact；project 范围只接受真实项目 id。
    const instByName = text(raw.scope_id) ? db.prepare('SELECT id,type_id,name FROM loop_ontology_instances WHERE owner=? AND (name=? OR id=?) LIMIT 1').get(source.owner || OWNER_DEFAULT, text(raw.scope_id), text(raw.scope_id)) : null
    if (instByName) { scope = 'artifact'; scopeId = instByName.name; objectType = instByName.type_id; objectId = instByName.id }
    else if (scope === 'project' && source.project) scopeId = source.project
    const actions = Array.isArray(raw.actions) ? raw.actions.filter((a) => a && typeof a === 'object') : []
    const evidence = (Array.isArray(raw.evidence_message_ids) ? raw.evidence_message_ids : []).map((tag) => tagMap.get(tag)).filter(Boolean)
    if (!evidence.length || !actions.length) return null
    const conditions = remapGenericConditionPaths(normalizeConditionForOntology(raw.conditions && typeof raw.conditions === 'object' ? raw.conditions : {}, source.owner), objectType)
    const errors = validateCondition(conditions)
    const speaker = evidence.some((m) => m.role === 'user') ? 'user' : evidence.some((m) => m.role === 'assistant') ? 'assistant' : 'unknown'
    const sourceCategory = speaker === 'user' ? 'user_statement' : 'model_suggestion'
    const ontologyErrors = Object.keys(conditions).length ? conditionPathErrors(conditions) : []
    const allErrors = [...errors, ...ontologyErrors]
    const id = uid('rule')
    const unstructured = allErrors.length || !Object.keys(conditions).length
    db.prepare(`INSERT INTO loop_rules(id,name,description,category,scope_type,scope_id,owner,project,task,object_type,object_id,trigger_event,conditions_json,actions_json,strength,exceptions_json,acceptance,source_category,evidence_json,confidence,confirmation,valid_from,valid_to,governance_status,version,structure_status,created_at,updated_at,structure_errors_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, text(raw.name) || '未命名规则', text(raw.description) || '', RULE_CATEGORIES.includes(raw.category) ? raw.category : 'business_constraint',
      scope, scopeId || null, source.owner || OWNER_DEFAULT, source.project, source.task,
      objectType, objectId, raw.trigger_event || null, JSON.stringify(conditions), JSON.stringify(actions),
      STRENGTHS.includes(raw.strength) ? raw.strength : 'prefer', JSON.stringify(Array.isArray(raw.exceptions) ? raw.exceptions : []),
      text(raw.acceptance) || '', sourceCategory, JSON.stringify(evidence.map((e) => ({ message_id: e.id, quote: e.content.slice(0, 300) }))),
      Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0.5, 'candidate',
      null, null, 'candidate', 1, unstructured ? (allErrors.length ? 'invalid_condition' : 'unstructured') : 'structured', now(), now(),
      JSON.stringify(allErrors))
    audit('rule.candidate', 'rule', id, { source_id: source.id, structure_status: unstructured ? 'needs_structure' : 'structured' })
    return { id, structure_status: unstructured ? (allErrors.length ? 'invalid_condition' : 'unstructured') : 'structured', errors: allErrors }
  }

  /* ------------------------------------------------------------------ 抽取批次 */

  function saveBatch(batch) {
    db.prepare(`INSERT INTO loop_batches(id,source_id,kind,status,total,done,failed,error,created_at,updated_at,detail_json,source_hash,generation)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      batch.id, batch.source_id ?? null, batch.kind, batch.status, batch.total, batch.done, batch.failed,
      batch.error || '', batch.created_at || now(), now(), JSON.stringify(batch.detail || {}), batch.source_hash || '', batch.generation || 1)
  }
  function updateBatch(batch) {
    const done = batch.chunks.filter((c) => c.status === 'succeeded' || c.status === 'skipped').length
    const failed = batch.chunks.filter((c) => c.status === 'failed').length
    const status = failed === 0 ? (done === batch.total ? 'done' : 'running') : done + failed === batch.total ? 'partial' : 'running'
    db.prepare('UPDATE loop_batches SET status=?,done=?,failed=?,error=?,updated_at=?,detail_json=? WHERE id=?')
      .run(status, done, failed, batch.error || '', now(), JSON.stringify({ chunks: batch.chunks }), batch.id)
    batch.done = done; batch.failed = failed; batch.status = status
    return batch
  }
  function totalCounts(batch) {
    return batch.chunks.reduce((acc, c) => {
      for (const k of ['memories_added', 'memories_duplicate', 'conflicts', 'rules_added', 'proposals', 'skipped_protected']) acc[k] = (acc[k] || 0) + (Number(c[k]) || 0)
      return acc
    }, { memories_added: 0, memories_duplicate: 0, conflicts: 0, rules_added: 0, proposals: 0, skipped_protected: 0 })
  }

  async function extractChunk(source, chunk, batch, { force = false, assertCurrent = () => {}, modelSelection=null } = {}) {
    assertCurrent()
    assertExtractionSource(source)
    const prior = db.prepare('SELECT * FROM loop_extraction_runs WHERE source_id=? AND chunk_key=? AND status=\'succeeded\'').get(source.id, chunk.key)
    if (prior && !force) return { status: 'skipped', memories_added: 0, memories_duplicate: prior.memory_count, rules_added: prior.rule_count, conflicts: 0, proposals: 0, skipped_protected: 0, run_id: prior.id }
    const runId = uid('ext')
    let raw
    try {
      raw = await callModel([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `来源：${source.title || source.id}（分块 ${chunk.index + 1}）\n\n${chunk.text}` },
      ],modelSelection)
    } catch (e) {
      assertCurrent()
      assertExtractionSource(source)
      db.prepare('UPDATE loop_sources SET extraction_status=?, extraction_error=? WHERE id=?').run('error', String(e.message || e).slice(0, 500), source.id)
      throw Object.assign(new Error(`模型提取失败：${e.message || e}`), { code: 'MODEL_UNAVAILABLE', run_id: runId })
    }
    let parsed
    try { parsed = parseModelJson(raw) } catch (e) {
      throw Object.assign(new Error(`模型 JSON 解析失败：${e.message}；原始输出：${String(raw).slice(0, 700)}`), { code: 'MODEL_JSON', run_id: runId })
    }
    const out = { status: 'succeeded', memories_added: 0, memories_duplicate: 0, conflicts: 0, rules_added: 0, proposals: 0, skipped_protected: 0, run_id: runId }
    const savedMemoryIds = []
    tx(() => {
      assertCurrent()
      assertExtractionSource(source)
      const completed = db.prepare("SELECT id FROM loop_extraction_runs WHERE source_id=? AND chunk_key=? AND status='succeeded'").get(source.id, chunk.key)
      if (completed && !force) { out.status='skipped';return }
      for (const r of parsed.memories) {
        const m = normalizeMemory(r, source, chunk.map)
        if (!m) continue
        const saved = saveMemory(m, source, runId)
        savedMemoryIds.push(saved.id)
        if (saved.duplicate) out.memories_duplicate++
        else out.memories_added++
        if (saved.conflict) out.conflicts++
        if (saved.protected_conflict) out.skipped_protected++
      }
      for (const r of parsed.rules) {
        const saved = saveRule(r, source, chunk.map, runId)
        if (saved) out.rules_added++
      }
      for (const p of parsed.ontology_candidates) {
        if (!p || !p.kind) continue
        db.prepare('INSERT INTO loop_ontology_proposals(id,kind,payload_json,status,evidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(uid('prop'), String(p.kind), JSON.stringify(p), 'candidate', source.title || source.id, now(), now())
        out.proposals++
      }
      db.prepare('DELETE FROM loop_extraction_runs WHERE source_id=? AND chunk_key=?').run(source.id, chunk.key)
      db.prepare(`INSERT INTO loop_extraction_runs(id,source_id,batch_id,chunk_index,chunk_key,content_hash,prompt_version,schema_version,model,status,error,memory_count,rule_count,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, source.id, batch.id, chunk.index, chunk.key, source.content_hash, PROMPT_VERSION, RULE_SCHEMA_VERSION, modelSelection?.model || model, 'succeeded', '', out.memories_added + out.memories_duplicate, out.rules_added, now())
    })
    if (savedMemoryIds.length) enqueueEmbedJob([...new Set(savedMemoryIds)], source.owner || OWNER_DEFAULT)
    return out
  }

  async function extractSource(sourceId, { force = false, onProgress = null, shouldCancel = null, jobId = null, assertCurrent = () => {}, modelSelection=null } = {}) {
    assertCurrent()
    const source = getSource(sourceId)
    if (!source) throw Object.assign(new Error('导入记录不存在'), { code: 'NOT_FOUND' })
    if (source.archived_at) throw Object.assign(new Error('来源已归档，不能继续拆解'), { code: 'ARCHIVED' })
    modelSelection=modelSelection || capturedChatModel(source)
    if(source.source_kind==='dsh-auto' && !modelSelection)throw new Error('未能确认原聊天使用的模型，原文保留，不切换抽取端点')
    const messages = getMessages(sourceId)
    if (!messages.length) throw Object.assign(new Error('来源没有消息'), { code: 'EMPTY' })
    if (!endpoint || !model) throw Object.assign(new Error('模型未配置'), { code: 'MODEL_UNAVAILABLE' })
    const chunks = buildExtractionChunks(source, messages,6000,12,modelSelection?`${modelSelection.provider}/${modelSelection.model}`:model)
    const generation = (db.prepare('SELECT MAX(generation) AS g FROM loop_batches WHERE source_id=? AND kind=\'extract\'').get(sourceId)?.g || 0) + 1
    const batch = {
      id: uid('batch'), source_id: sourceId, kind: 'extract', status: 'running', total: chunks.length, done: 0, failed: 0,
      error: '', created_at: now(), source_hash: source.content_hash, generation,
      chunks: chunks.map((c) => ({ index: c.index, status: 'queued', error: '', memories_added: 0, memories_duplicate: 0, conflicts: 0, rules_added: 0, proposals: 0, skipped_protected: 0 })),
    }
    saveBatch(batch)
    db.prepare('UPDATE loop_sources SET extraction_status=? WHERE id=?').run('extracting', sourceId)
    let cancelled = false
    for (const chunk of chunks) {
      if (shouldCancel?.()) {
        cancelled = true
        for (const rest of batch.chunks.slice(chunk.index)) { rest.status = 'cancelled'; rest.error = '任务已取消' }
        batch.error = '任务已取消'
        updateBatch(batch)
        break
      }
      const slot = batch.chunks[chunk.index]
      slot.status = 'running'
      updateBatch(batch)
      let out = null
      try {
        out = await extractChunk(source, chunk, batch, { force, assertCurrent, modelSelection })
        Object.assign(slot, out)
        slot.status = out.status
      } catch (e) {
        if (['LEASE_LOST','ARCHIVED','SOURCE_CHANGED'].includes(e.code)) throw e
        slot.status = 'failed'
        slot.error = String(e.message || e).slice(0, 500)
        slot.run_id = e.run_id || null
        batch.error = slot.error
      }
      updateBatch(batch)
      onProgress?.({ done: batch.done, failed: batch.failed, total: batch.total, batch_status: batch.status, ...(out || {}) })
    }
    const counts = totalCounts(batch)
    const status = cancelled ? 'cancelled' : batch.status
    const sourceStatus = cancelled ? 'raw_saved' : batch.status === 'done' ? 'extracted' : 'error'
    db.prepare('UPDATE loop_sources SET extraction_status=?, extraction_error=? WHERE id=?').run(sourceStatus, cancelled ? '任务已取消，原文保留' : batch.status === 'partial' ? '部分分块失败，可重试' : batch.error || '', sourceId)
    audit('source.extract', 'source', sourceId, { batch_id: batch.id, generation, ...counts, model:modelSelection?.model || model, force, status })
    return { source_id: sourceId, batch_id: batch.id, status, chunks: batch.chunks, ...counts, failed_chunks: batch.failed, model:modelSelection?.model || model }
  }

  async function retryBatch(batchId) {
    const row = db.prepare('SELECT * FROM loop_batches WHERE id=?').get(batchId)
    if (!row) throw Object.assign(new Error('批次不存在'), { code: 'NOT_FOUND' })
    const source = getSource(row.source_id)
    if (!source) throw Object.assign(new Error('来源不存在'), { code: 'NOT_FOUND' })
    if(source.archived_at)throw Object.assign(new Error('来源已归档'),{code:'ARCHIVED'})
    const modelSelection=capturedChatModel(source)
    if(source.source_kind==='dsh-auto' && !modelSelection)throw new Error('未能确认原聊天使用的模型，原文保留，不切换抽取端点')
    const detail = json(row.detail_json, {})
    const chunks = Array.isArray(detail.chunks) ? detail.chunks : []
    const messages = getMessages(source.id)
    const built = buildExtractionChunks(source, messages,6000,12,modelSelection?`${modelSelection.provider}/${modelSelection.model}`:model)
    const batch = { ...row, chunks, detail, total: row.total, done: row.done, failed: row.failed, status: row.status }
    for (const slot of chunks) {
      if (slot.status !== 'failed' && slot.status !== 'queued') continue
      const chunk = built[slot.index]
      if (!chunk) continue
      slot.status = 'running'; slot.error = ''
      updateBatch(batch)
      try {
        const out = await extractChunk(source, chunk, batch, { force: true,modelSelection })
        Object.assign(slot, out); slot.status = out.status
      } catch (e) {
        if(['ARCHIVED','SOURCE_CHANGED'].includes(e.code))throw e
        slot.status = 'failed'; slot.error = String(e.message || e).slice(0, 500)
      }
      updateBatch(batch)
    }
    const counts = totalCounts(batch)
    if (batch.status === 'done') db.prepare('UPDATE loop_sources SET extraction_status=?, extraction_error=? WHERE id=?').run('extracted', '', source.id)
    else if (batch.status === 'partial') db.prepare('UPDATE loop_sources SET extraction_status=?, extraction_error=? WHERE id=?').run('error', '部分分块失败，可重试', source.id)
    return { batch_id: batch.id, status: batch.status, chunks, ...counts, failed_chunks: batch.failed }
  }

  /* ---------------------------------------------------------------- 持久任务队列 */

  const WORKER_ID = `worker_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
  let workerTimer = null
  let workerBusy = false

  function jobJson(row) {
    if (!row) return null
    return {
      ...row,
      payload: json(row.payload_json, {}),
      result: json(row.result_json, {}),
      progress: row.progress_total > 0 ? Math.min(1, (row.progress_done + (row.status === 'partial' ? 0 : 0)) / row.progress_total) : 0,
      lease_expired: !!(row.lease_until && row.lease_until < now()),
      cancel_requested: !!row.cancel_requested,
    }
  }

  function enqueueJob({ type, owner = OWNER_DEFAULT, sourceId = null, payload = {}, idempotencyKey, maxAttempts = jobMaxAttempts }) {
    if (!idempotencyKey) throw new Error('任务缺少幂等键')
    const existing = db.prepare(`SELECT * FROM loop_jobs WHERE idempotency_key=? AND status IN ('queued','running') LIMIT 1`).get(idempotencyKey)
    if (existing) return { job: jobJson(existing), duplicate: true }
    const id = uid('job')
    db.prepare(`INSERT INTO loop_jobs(id,owner,type,source_id,status,progress_done,progress_total,attempts,max_attempts,idempotency_key,payload_json,created_at,updated_at)
      VALUES(?,?,?,?,'queued',0,0,0,?,?,?,?,?)`).run(id, ownerOf(owner), type, sourceId, maxAttempts, idempotencyKey, JSON.stringify(payload), now(), now())
    if (sourceId && type === 'extract') db.prepare('UPDATE loop_sources SET extraction_status=? WHERE id=?').run('queued', sourceId)
    audit('job.enqueue', 'job', id, { type, source_id: sourceId })
    scheduleWorker(0)
    return { job: jobJson(db.prepare('SELECT * FROM loop_jobs WHERE id=?').get(id)), duplicate: false }
  }

  function enqueueExtractJob(source, { force = false, owner = OWNER_DEFAULT, modelSelection = null } = {}) {
    modelSelection=modelSelection || capturedChatModel(source)
    if(source.source_kind==='dsh-auto' && !modelSelection)throw new Error('未能确认原聊天使用的模型，原文保留，不切换抽取端点')
    const key = `extract:${source.id}:${source.content_hash}:${PROMPT_VERSION}:${force ? `force:${Date.now()}` : 'normal'}`
    return enqueueJob({ type: 'extract', owner: source.owner || owner, sourceId: source.id, idempotencyKey: key, payload: { source_id: source.id, force: !!force, prompt_version: PROMPT_VERSION, ...(modelSelection?{model_selection:{provider:modelSelection.provider,model:modelSelection.model}}:{}) } })
  }

  function requeueExpiredJobs() {
    const nowIso = now()
    const expired = db.prepare(`SELECT id, cancel_requested, attempts, max_attempts FROM loop_jobs WHERE status='running' AND (lease_until IS NULL OR lease_until < ?)`).all(nowIso)
    for (const row of expired) {
      if (row.cancel_requested) {
        db.prepare(`UPDATE loop_jobs SET status='cancelled', lease_owner=NULL, lease_until=NULL, error=?, finished_at=?, updated_at=? WHERE id=?`).run('任务已取消', now(), now(), row.id)
      } else {
        db.prepare(`UPDATE loop_jobs SET status='queued', lease_owner=NULL, lease_until=NULL, error=?, updated_at=? WHERE id=?`).run('租约过期，已重新入队', now(), row.id)
        audit('job.requeue', 'job', row.id, { reason: 'lease_expired' })
      }
    }
  }

  function claimNextJob() {
    const candidate = db.prepare(`SELECT * FROM loop_jobs WHERE status='queued' AND (?=1 OR json_type(payload_json,'$.model_selection') IS NULL) ORDER BY created_at, id LIMIT 1`).get(chatExtractionModel?1:0)
    if (!candidate) return null
    const nowIso = now()
    const lease = new Date(Date.now() + jobLeaseMs).toISOString()
    const res = db.prepare(`UPDATE loop_jobs SET status='running', lease_owner=?, lease_until=?, attempts=attempts+1, started_at=COALESCE(started_at,?), updated_at=? WHERE id=? AND status='queued'`)
      .run(WORKER_ID, lease, nowIso, nowIso, candidate.id)
    if (!res.changes) return null
    return db.prepare('SELECT * FROM loop_jobs WHERE id=?').get(candidate.id)
  }

  function finishJob(job, { status, result = {}, error = '' }) {
    assertJobOwner(job)
    const done = Number(result.chunks
      ? result.chunks.filter((c) => ['succeeded', 'skipped'].includes(c.status)).length
      : (result.done != null ? Number(result.done) + Number(result.skipped || 0) : job.progress_done)) || 0
    const total = Number(result.chunks ? result.chunks.length : (result.done != null ? Number(result.done) + Number(result.failed || 0) + Number(result.skipped || 0) : job.progress_total)) || 0
    db.prepare(`UPDATE loop_jobs SET status=?,progress_done=?,progress_total=?,result_json=?,error=?,finished_at=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE id=?`)
      .run(status, done, total, JSON.stringify(result || {}), String(error || '').slice(0, 1000), now(), now(), job.id)
    audit('job.finish', 'job', job.id, { type: job.type, status, failed: result.failed_chunks || 0 })
  }

  function failJob(job, err) {
    if (!isJobOwner(job) || err?.code === 'LEASE_LOST') return
    const message = String(err?.message || err).slice(0, 1000)
    const attempts = Number(job.attempts) || 0
    const retryable = !['NOT_FOUND', 'ARCHIVED', 'SOURCE_CHANGED', 'EMPTY'].includes(err?.code) && attempts < (Number(job.max_attempts) || jobMaxAttempts)
    if (retryable) {
      db.prepare(`UPDATE loop_jobs SET status='queued',lease_owner=NULL,lease_until=NULL,error=?,updated_at=? WHERE id=?`).run(message, now(), job.id)
      audit('job.retry', 'job', job.id, { attempts, error: message })
    } else {
      db.prepare(`UPDATE loop_jobs SET status='failed',error=?,finished_at=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE id=?`).run(message, now(), now(), job.id)
      audit('job.failed', 'job', job.id, { attempts, error: message })
    }
  }

  function isJobOwner(job) {
    const current = db.prepare('SELECT status,lease_owner,attempts FROM loop_jobs WHERE id=?').get(job.id)
    return current?.status === 'running' && current.lease_owner === job.lease_owner && current.attempts === job.attempts
  }
  function assertJobOwner(job) {
    if (!isJobOwner(job)) throw Object.assign(new Error('任务租约已被其他 worker 接管'),{code:'LEASE_LOST'})
  }
  async function runJob(job) {
    const heartbeat = setInterval(() => {
      try { db.prepare("UPDATE loop_jobs SET lease_until=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND attempts=?")
        .run(new Date(Date.now()+jobLeaseMs).toISOString(),now(),job.id,job.lease_owner,job.attempts) } catch { /* Runtime may be shutting down. */ }
    }, Math.max(1000,Math.floor(jobLeaseMs/3)))
    heartbeat.unref?.()
    try { return await performJob(job) } finally { clearInterval(heartbeat) }
  }
  async function performJob(job) {
    assertJobOwner(job)
    const payload = json(job.payload_json, {})
    if (job.type === 'extract') {
      const source = getSource(payload.source_id || job.source_id)
      if (!source) throw Object.assign(new Error('来源不存在'), { code: 'NOT_FOUND' })
      const out = await extractSource(source.id, {
        force: !!payload.force,
        modelSelection:payload.model_selection || null,
        jobId: job.id,
        assertCurrent: () => assertJobOwner(job),
        shouldCancel: () => !!db.prepare('SELECT cancel_requested FROM loop_jobs WHERE id=?').get(job.id)?.cancel_requested,
        onProgress: (p) => {
          assertJobOwner(job)
          db.prepare('UPDATE loop_jobs SET progress_done=?,progress_total=?,lease_until=?,updated_at=? WHERE id=?').run(p.done, p.total, new Date(Date.now() + jobLeaseMs).toISOString(), now(), job.id)
        },
      })
      const failedChunks = Number(out.failed_chunks) || 0
      const total = out.chunks?.length || 0
      const status = out.status === 'cancelled' ? 'cancelled'
        : failedChunks === 0 ? 'done'
          : failedChunks >= total ? 'failed' : 'partial'
      finishJob(job, { status, result: out, error: status === 'failed' ? (out.chunks.filter((c) => c.error).map((c) => c.error).join('；').slice(0, 800)) : '' })
      return
    }
    if (job.type === 'embed') {
      const out = await runEmbedJob(payload, () => assertJobOwner(job))
      finishJob(job, { status: out.failed > 0 ? (out.done > 0 ? 'partial' : 'failed') : 'done', result: out, error: out.error || '' })
      return
    }
    throw new Error(`未知任务类型：${job.type}`)
  }

  async function jobTick() {
    if (!workerEnabled || workerBusy) return
    workerBusy = true
    try {
      requeueExpiredJobs()
      const job = claimNextJob()
      if (job) {
        try { await runJob(job) } catch (e) { failJob(job, e) }
      }
    } catch (e) {
      logger?.warn?.(`[memory-brain] job worker failed: ${e?.message || e}`)
    } finally {
      workerBusy = false
    }
  }

  function scheduleWorker(delay = 0) {
    if (!workerEnabled) return
    const t = setTimeout(() => { jobTick() }, Math.max(0, delay))
    t.unref?.()
  }

  function startWorker() {
    if (workerTimer) return
    requeueExpiredJobs()
    if (!workerEnabled) return
    workerTimer = setInterval(jobTick, workerIntervalMs)
    workerTimer.unref?.()
    scheduleWorker(0)
  }

  function stopWorker() {
    if (workerTimer) clearInterval(workerTimer)
    workerTimer = null
  }

  /* ---------------------------------------------------------------- 向量召回 */

  let embedProbeCache = { at: 0, ok: null, error: '' }
  let embedQueryCooldownUntil = 0

  function memoryContentHash(m) {
    return sha([m.text || '', m.subject || '', m.predicate || '', m.object_value || '', m.type || ''].join('|'))
  }

  async function callEmbeddings(inputs, { timeout = null } = {}) {
    if (!embedEnabled) throw Object.assign(new Error('向量检索未配置'), { code: 'EMBED_UNAVAILABLE' })
    const headers = { 'Content-Type': 'application/json' }
    if (embedApiKeyEnv && process.env[embedApiKeyEnv]) headers.Authorization = `Bearer ${process.env[embedApiKeyEnv]}`
    const res = await fetch(embedEndpoint, {
      method: 'POST', headers,
      body: JSON.stringify({ model: embedModel, input: inputs }),
      signal: AbortSignal.timeout(Number(timeout) || Math.min(timeoutMs, 20_000)),
    })
    if (!res.ok) throw Object.assign(new Error(`embedding HTTP ${res.status}`), { code: 'EMBED_UNAVAILABLE' })
    const data = await res.json().catch(() => null)
    const rows = Array.isArray(data?.data) ? data.data : []
    if (rows.length !== inputs.length) throw Object.assign(new Error('embedding 返回数量与输入不一致'), { code: 'EMBED_INVALID' })
    const vectors = rows.map((r) => Array.isArray(r.embedding) ? r.embedding.map(Number) : null)
    if (vectors.some((v) => !v || !v.length || v.some((x) => !Number.isFinite(x)))) throw Object.assign(new Error('embedding 向量不合法'), { code: 'EMBED_INVALID' })
    return vectors
  }

  async function probeEmbedding(force = false) {
    if (!embedEnabled) return { ok: false, error: 'not_configured' }
    if (!force && Date.now() - embedProbeCache.at < 30_000) return { ok: embedProbeCache.ok, error: embedProbeCache.error }
    let ok = false; let error = ''
    try {
      const probeUrl = /\/embeddings\/?$/i.test(embedEndpoint) ? embedEndpoint.replace(/\/embeddings\/?$/i, '/models') : embedEndpoint
      const headers = {}
      if (embedApiKeyEnv && process.env[embedApiKeyEnv]) headers.Authorization = `Bearer ${process.env[embedApiKeyEnv]}`
      const res = await fetch(probeUrl, { headers, signal: AbortSignal.timeout(3000) })
      ok = res.ok; if (!res.ok) error = `HTTP ${res.status}`
    } catch (e) { error = String(e.message || e) }
    embedProbeCache = { at: Date.now(), ok, error }
    return { ok, error }
  }

  function embeddingStatus(owner = OWNER_DEFAULT, { probe = false } = {}) {
    const memories = db.prepare('SELECT id,text,subject,predicate,object_value,type FROM loop_memories WHERE owner=? LIMIT 5000').all(owner)
    const rows = db.prepare('SELECT * FROM loop_embeddings WHERE model=?').all(embedModel)
    const byId = new Map(rows.map((r) => [r.memory_id, r]))
    let embedded = 0; let stale = 0
    for (const m of memories) {
      const e = byId.get(m.id)
      if (!e) continue
      if (e.content_hash === memoryContentHash(m)) embedded++; else stale++
    }
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM loop_jobs WHERE owner=? AND type='embed' AND status IN ('queued','running')`).get(owner).n
    return {
      configured: embedEnabled,
      endpoint: embedEnabled ? embedEndpoint : '',
      model: embedModel,
      counts: { memories: memories.length, embedded, stale, missing: memories.length - embedded - stale, pending_jobs: pending },
      available: null,
      note: embedEnabled ? '向量只参与排序；硬约束确定性加载；embedding 失败自动降级词法检索' : '向量未配置：上下文只使用词法/关联检索',
    }
  }

  function enqueueEmbedJob(memoryIds, owner = OWNER_DEFAULT) {
    if (!embedEnabled) return null
    const ids = [...new Set((memoryIds || []).filter(Boolean))]
    if (!ids.length) return null
    const rows = db.prepare(`SELECT * FROM loop_memories WHERE owner=? AND id IN (${ids.map(() => '?').join(',')})`).all(owner, ...ids)
    if (!rows.length) return null
    const key = `embed:${embedModel}:${sha(ids.slice().sort().join(','))}`
    return enqueueJob({ type: 'embed', owner, idempotencyKey: key, payload: { memory_ids: rows.map((r) => r.id), model: embedModel } })
  }

  async function runEmbedJob(payload = {}, assertCurrent = () => {}) {
    if (!embedEnabled) throw Object.assign(new Error('向量检索未配置'), { code: 'EMBED_UNAVAILABLE' })
    const ids = Array.isArray(payload.memory_ids) ? payload.memory_ids : []
    const out = { done: 0, failed: 0, skipped: 0, dimension: null, model: embedModel, error: '' }
    const batchSize = 8
    for (let i = 0; i < ids.length; i += batchSize) {
      const batchIds = ids.slice(i, i + batchSize)
      const rows = db.prepare(`SELECT * FROM loop_memories WHERE id IN (${batchIds.map(() => '?').join(',')})`).all(...batchIds)
      const pending = []
      for (const row of rows) {
        const hash = memoryContentHash(row)
        const existing = db.prepare('SELECT content_hash FROM loop_embeddings WHERE memory_id=? AND model=?').get(row.id, embedModel)
        if (existing && existing.content_hash === hash) { out.skipped++; continue }
        pending.push({ row, hash })
      }
      if (!pending.length) continue
      try {
        const vectors = await callEmbeddings(pending.map((x) => x.row.text))
        tx(() => {
          assertCurrent()
          for (const [j, item] of pending.entries()) {
            const vec = vectors[j]
            db.prepare(`INSERT INTO loop_embeddings(memory_id,model,dimension,vector_json,content_hash,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(memory_id,model) DO UPDATE SET dimension=excluded.dimension,vector_json=excluded.vector_json,content_hash=excluded.content_hash,updated_at=excluded.updated_at`)
              .run(item.row.id, embedModel, vec.length, JSON.stringify(vec), item.hash, now(), now())
            out.done++
          }
        })
        out.dimension = vectors[0]?.length || out.dimension
      } catch (e) {
        out.failed += pending.length
        out.error = String(e.message || e).slice(0, 500)
      }
    }
    return out
  }

  function reindexEmbeddings(owner = OWNER_DEFAULT) {
    if (!embedEnabled) return { ok: false, error: 'embed_unconfigured', message: '向量检索未配置；未生成任何向量' }
    const rows = db.prepare('SELECT id FROM loop_memories WHERE owner=? ORDER BY created_at LIMIT 5000').all(owner)
    const enq = enqueueEmbedJob(rows.map((r) => r.id), owner)
    return enq ? { ok: true, job: enq.job, queued: rows.length } : { ok: true, job: null, queued: 0 }
  }

  function cosine(a, b) {
    let dot = 0; let na = 0; let nb = 0
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    if (!na || !nb) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  }

  async function vectorScoresFor(memories, query) {
    const meta = { configured: embedEnabled, used: false, model: embedModel, dimension: null, query_embedded: false, matched: 0, error: '' }
    if (!embedEnabled) { meta.error = 'not_configured'; return { scores: new Map(), meta } }
    if (!text(query)) { meta.error = 'empty_query'; return { scores: new Map(), meta } }
    if (Date.now() < embedQueryCooldownUntil) { meta.error = 'embedding_cooldown'; return { scores: new Map(), meta } }
    let queryVector
    try {
      const vecs = await callEmbeddings([text(query)], { timeout: 5000 })
      queryVector = vecs[0]
      meta.query_embedded = true
      meta.dimension = queryVector.length
    } catch (e) {
      meta.error = String(e.message || e).slice(0, 300)
      embedQueryCooldownUntil = Date.now() + 30_000
      return { scores: new Map(), meta }
    }
    const ids = memories.map((m) => m.id)
    if (!ids.length) { meta.error = 'no_candidates'; return { scores: new Map(), meta } }
    const rows = db.prepare(`SELECT memory_id,vector_json,content_hash FROM loop_embeddings WHERE model=? AND memory_id IN (${ids.map(() => '?').join(',')})`).all(embedModel, ...ids)
    const byId = new Map(rows.map((r) => [r.memory_id, r]))
    const scores = new Map()
    for (const m of memories) {
      const row = byId.get(m.id)
      if (!row || row.content_hash !== memoryContentHash(m)) continue
      try {
        const vec = JSON.parse(row.vector_json)
        if (!Array.isArray(vec) || vec.length !== queryVector.length) continue
        scores.set(m.id, cosine(queryVector, vec))
      } catch { /* 损坏向量不参与排序 */ }
    }
    meta.used = meta.query_embedded && scores.size > 0
    meta.matched = scores.size
    return { scores, meta }
  }


  async function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = []
      req.on('data', (c) => { size += c.length; if (size > 8_000_000) { reject(new Error('请求体过大')); req.destroy(); return } chunks.push(c) })
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { reject(new Error('JSON 无效')) } })
      req.on('error', reject)
    })
  }

  function createSource(body, parsed) {
    const validation = validateImportFile({ filename: body.filename, text: parsed.raw, sizeBytes: body.sizeBytes, mimeType: body.mimeType })
    if (!validation.ok) throw Object.assign(new Error(validation.errors.join('；')), { code: 'INVALID_FILE', errors: validation.errors })
    parsed.warnings = [...new Set([...(parsed.warnings || []), ...validation.warnings])]
    const roleFixes = applyRoleOverrides(parsed, body.roleOverrides)
    const owner = ownerOf(body.owner)
    const project = text(body.project) || null
    const task = text(body.task) || null
    const platform = text(body.platform) || 'local'
    const externalId = text(body.externalConversationId) || null
    const fileName = text(body.filename) || null
    const kind = text(body.kind) || (fileName ? 'file' : 'paste')
    const attachments = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 50).map((a) => ({
      name: text(a?.name || '附件'), size: Number(a?.size) || null, type: text(a?.type || a?.mimeType) || null, parsed: false,
    }))
    const existingByExt = externalId ? db.prepare('SELECT * FROM loop_sources WHERE external_conversation_id=? AND owner=? ORDER BY imported_at DESC LIMIT 1').get(externalId, owner) : null
    const existingByFile = fileName ? db.prepare('SELECT * FROM loop_sources WHERE source_kind=? AND file_name=? AND content_hash=? AND owner=? AND archived_at IS NULL LIMIT 1').get(kind, fileName, parsed.hash, owner) : null
    if (existingByFile) return { duplicate: true, source: existingByFile, appended: 0, warnings: parsed.warnings }
    const id = existingByExt?.id || uid('src')
    const title = text(body.title) || (fileName ? fileName.replace(/\.[^.]+$/, '') : parsed.messages.find((m) => m.role === 'user')?.content.slice(0, 40) || '未命名对话')
    const externalConversationId = existingByExt?.external_conversation_id || externalId
    if (existingByExt) {
      db.prepare('UPDATE loop_sources SET content_hash=?, raw_text=?, imported_at=?, extraction_status=?, warnings_json=?, attachments_json=?, role_overrides_json=?, file_name=COALESCE(file_name,?), platform=? WHERE id=?')
        .run(parsed.hash, parsed.raw, now(), 'raw_saved', JSON.stringify(parsed.warnings), JSON.stringify(attachments), JSON.stringify(parsed.roleOverrides || {}), fileName, platform, id)
    } else {
      db.prepare(`INSERT INTO loop_sources(id,source_kind,platform,external_conversation_id,title,owner,project,task,file_name,content_hash,raw_text,imported_at,extraction_status,warnings_json,attachments_json,role_overrides_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, kind, platform, externalConversationId, title, owner, project, task, fileName, parsed.hash, parsed.raw, now(), 'raw_saved', JSON.stringify(parsed.warnings), JSON.stringify(attachments), JSON.stringify(parsed.roleOverrides || {}))
    }
    const existingMessages = getMessages(id)
    // 增量导入：已有消息作为前缀匹配；只追加新消息。相同内容在不同位置仍保留为不同证据。
    let skip = 0
    if (existingMessages.length) {
      const limit = Math.min(existingMessages.length, parsed.messages.length)
      let p = 0
      while (p < limit && existingMessages[p].role === parsed.messages[p].role
        && existingMessages[p].content_hash === sha(parsed.messages[p].content)) p++
      if (p === existingMessages.length) skip = p
      else parsed.warnings.push('增量内容与已有消息前缀不一致：已保留全部新消息作为独立证据，并追加到末尾')
    }
    const maxOrdinal = db.prepare('SELECT MAX(ordinal) AS n FROM loop_messages WHERE source_id=?').get(id)?.n
    let ordinal = Number(maxOrdinal ?? -1) + 1
    let appended = 0
    const insert = db.prepare(`INSERT INTO loop_messages(id,source_id,external_message_id,parent_id,role,ordinal,content,original_time,timezone,content_hash,attachment_json,warnings_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    for (const [i, m] of parsed.messages.entries()) {
      if (i < skip) continue
      let external = m.externalId ? String(m.externalId) : `pos:${i}:${sha(m.role + '\u0000' + m.content).slice(0, 20)}`
      const dup = db.prepare('SELECT role,content_hash FROM loop_messages WHERE source_id=? AND external_message_id=?').get(id, external)
      if (dup?.role === m.role && dup.content_hash === sha(m.content)) continue
      if (dup) external += `:revision:${sha(m.role + '\u0000' + m.content).slice(0, 20)}`
      if (db.prepare('SELECT 1 FROM loop_messages WHERE source_id=? AND external_message_id=?').get(id, external)) continue
      insert.run(uid('msg'), id, external, m.parentId || null, m.role, ordinal, m.content, m.originalTime || null, m.timezone || null, sha(m.content), JSON.stringify(m.attachments || []), JSON.stringify((m.warnings || []).concat(m.role === 'unknown' ? ['角色未识别，按原文保存'] : [])), now())
      ordinal++; appended++
    }
    const batchId = uid('batch')
    db.prepare(`INSERT INTO loop_batches(id,source_id,kind,status,total,done,failed,error,created_at,updated_at,detail_json,source_hash,generation)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(batchId, id, 'import', 'done', parsed.messages.length, appended, 0, '', now(), now(), JSON.stringify({ role_overrides: roleFixes, skipped_existing: skip }), parsed.hash, 1)
    audit('source.import', 'source', id, { kind, messages: appended, duplicate: false, role_fixes: roleFixes.length, attachments: attachments.length })
    return { duplicate: false, source: getSource(id), appended, batch_id: batchId, warnings: parsed.warnings, attachment_count: attachments.length, role_overrides: roleFixes }
  }

  /* ---------------------------------------------------------------- 本体结构版本 */

  function ontologyDefsSnapshot() {
    const types = db.prepare('SELECT * FROM loop_ontology_types ORDER BY id').all().map((t) => ({
      id: t.id, name: t.name, description: t.description || '', version: t.version || 1, status: t.status || 'published', created_at: t.created_at,
      props: db.prepare('SELECT * FROM loop_ontology_props WHERE type_id=? ORDER BY name').all(t.id).map((p) => ({
        id: p.id, type_id: p.type_id, name: p.name, datatype: p.datatype, unit: p.unit || null, enum_json: p.enum_json || '[]', required: Number(p.required) || 0, created_at: p.created_at,
      })),
      states: db.prepare('SELECT * FROM loop_ontology_states WHERE type_id=? ORDER BY name').all(t.id).map((x) => ({
        id: x.id, type_id: x.type_id, name: x.name, transitions_json: x.transitions_json || '[]', created_at: x.created_at,
      })),
    }))
    const relations = db.prepare('SELECT * FROM loop_ontology_relations ORDER BY id').all().map((r) => ({
      id: r.id, name: r.name, from_type: r.from_type, to_type: r.to_type, description: r.description || '', created_at: r.created_at,
    }))
    return { types, relations }
  }

  function ontologyVersionRows() {
    return db.prepare('SELECT * FROM loop_ontology_versions ORDER BY version DESC').all()
  }

  function currentOntologyVersion() {
    return db.prepare('SELECT * FROM loop_ontology_versions ORDER BY version DESC LIMIT 1').get() || null
  }

  function diffOntologyDefs(prev, next) {
    const diff = { added: { types: [], props: [], relations: [], states: [] }, removed: { types: [], props: [], relations: [], states: [] }, changed: { types: [], props: [], relations: [], states: [] } }
    const prevTypes = new Map((prev?.types || []).map((t) => [t.id, t]))
    const nextTypes = new Map((next?.types || []).map((t) => [t.id, t]))
    for (const [id, t] of nextTypes) {
      const old = prevTypes.get(id)
      if (!old) diff.added.types.push({ id, name: t.name })
      else if (old.name !== t.name || old.description !== t.description) diff.changed.types.push({ id, before: { name: old.name, description: old.description }, after: { name: t.name, description: t.description } })
    }
    for (const [id, t] of prevTypes) if (!nextTypes.has(id)) diff.removed.types.push({ id, name: t.name })
    const flatten = (snap, field) => {
      const map = new Map()
      for (const t of snap?.types || []) for (const x of t[field] || []) map.set(`${t.id}.${x.name}`, { ...x, type_id: t.id })
      return map
    }
    for (const [kind, field] of [['props', 'props'], ['states', 'states']]) {
      const oldMap = flatten(prev, field); const newMap = flatten(next, field)
      for (const [key, x] of newMap) {
        if (!oldMap.has(key)) diff.added[kind].push({ key, name: x.name, type_id: x.type_id })
        else if (JSON.stringify(oldMap.get(key)) !== JSON.stringify(x)) diff.changed[kind].push({ key, before: oldMap.get(key), after: x })
      }
      for (const [key, x] of oldMap) if (!newMap.has(key)) diff.removed[kind].push({ key, name: x.name, type_id: x.type_id })
    }
    const oldRel = new Map((prev?.relations || []).map((r) => [r.id, r]))
    const newRel = new Map((next?.relations || []).map((r) => [r.id, r]))
    for (const [id, r] of newRel) {
      if (!oldRel.has(id)) diff.added.relations.push({ id, name: r.name })
      else if (JSON.stringify(oldRel.get(id)) !== JSON.stringify(r)) diff.changed.relations.push({ id, before: oldRel.get(id), after: r })
    }
    for (const [id, r] of oldRel) if (!newRel.has(id)) diff.removed.relations.push({ id, name: r.name })
    return diff
  }

  function validateOntologyStructure(snapshot) {
    const errors = []
    const types = new Set(snapshot.types.map((t) => t.id))
    for (const t of snapshot.types) {
      if (!t.id || !t.name) errors.push('类型缺少 id 或 name')
      for (const p of t.props || []) {
        if (!p.name) errors.push(`属性缺少 name（${t.id}）`)
        if (!['string', 'number', 'boolean', 'date'].includes(p.datatype)) errors.push(`属性 ${t.id}.${p.name} 数据类型不合法：${p.datatype}`)
        if (p.required && p.enum_json) { try { json(p.enum_json, []) } catch { errors.push(`属性 ${t.id}.${p.name} 枚举不是合法 JSON`) } }
      }
      for (const st of t.states || []) {
        try { const list = json(st.transitions_json, []); if (!Array.isArray(list)) errors.push(`状态 ${t.id}.${st.name} 转换必须是数组`) } catch { errors.push(`状态 ${t.id}.${st.name} 转换不是合法 JSON`) }
      }
    }
    for (const r of snapshot.relations) {
      if (!r.from_type || !types.has(r.from_type)) errors.push(`关系 ${r.name} 起点类型不存在：${r.from_type}`)
      if (!r.to_type || !types.has(r.to_type)) errors.push(`关系 ${r.name} 终点类型不存在：${r.to_type}`)
    }
    return [...new Set(errors)]
  }

  function saveOntologyVersion({ action, before, after, note = '', operator = OWNER_DEFAULT, changeSet = {}, affected = {} }) {
    const prev = currentOntologyVersion()
    const version = (prev ? Number(prev.version) : 0) + 1
    const diff = diffOntologyDefs(before || prevSnapshot(prev), after)
    const id = uid('ontver')
    db.prepare('INSERT INTO loop_ontology_versions(id,version,action,snapshot_json,diff_json,actor,note,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, version, action, JSON.stringify(after), JSON.stringify(diff), operator, note, now())
    db.prepare(`INSERT INTO loop_ontology_change_log(id,version_id,version,action,change_set_json,affected_types_json,affected_instances_json,affected_memories_json,affected_rules_json,operator,note,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      uid('ontlog'), id, version, action, JSON.stringify({ ...changeSet, diff }),
      JSON.stringify((diff.added.types || []).concat(diff.changed.types || [], diff.removed.types || []).map((t) => t.id || t.key)),
      JSON.stringify(affected.instances || []), JSON.stringify(affected.memories || []), JSON.stringify(affected.rules || []), operator, note, now())
    return { id, version, action, diff }
  }

  function prevSnapshot(versionRow) {
    try { return versionRow ? json(versionRow.snapshot_json, ontologyDefsSnapshot()) : ontologyDefsSnapshot() } catch { return ontologyDefsSnapshot() }
  }

  function ensureOntologyBaseline() {
    if (db.prepare('SELECT COUNT(*) AS n FROM loop_ontology_versions').get().n > 0) return
    const snapshot = ontologyDefsSnapshot()
    const errors = validateOntologyStructure(snapshot)
    if (errors.length) logger?.warn?.(`[memory-brain] ontology baseline validation: ${errors.join('；')}`)
    saveOntologyVersion({ action: 'baseline', before: { types: [], relations: [] }, after: snapshot, note: '初始化本体结构快照', changeSet: { kind: 'baseline' } })
    audit('ontology.baseline', 'ontology', null, { types: snapshot.types.length, relations: snapshot.relations.length })
  }

  function applyOntologyProposal(kind, payload = {}) {
    const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fa5-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
    if (kind === 'type') {
      const name = text(payload.name)
      if (!name) return { error: '类型候选缺少 name' }
      const id = `type_${slug(name) || sha(name).slice(0, 8)}`
      if (db.prepare('SELECT id FROM loop_ontology_types WHERE id=?').get(id)) return { error: `类型已存在：${name}` }
      if (db.prepare('SELECT id FROM loop_ontology_types WHERE name=?').get(name)) return { error: `类型名称重复：${name}` }
      db.prepare('INSERT INTO loop_ontology_types(id,name,description,version,status,created_at) VALUES(?,?,?,?,?,?)').run(id, name, text(payload.description), 1, 'published', now())
      return { kind, id, name }
    }
    if (kind === 'property') {
      const typeName = text(payload.type || payload.type_id)
      const name = text(payload.name || payload.property)
      if (!typeName || !name) return { error: '属性候选缺少 type/name' }
      const type = db.prepare('SELECT id FROM loop_ontology_types WHERE id=? OR name=? LIMIT 1').get(typeName, typeName)
      if (!type) return { error: `属性候选引用的类型不存在：${typeName}` }
      const datatype = text(payload.datatype) || 'string'
      if (!['string', 'number', 'boolean', 'date'].includes(datatype)) return { error: `属性数据类型不合法：${datatype}` }
      if (db.prepare('SELECT id FROM loop_ontology_props WHERE type_id=? AND name=?').get(type.id, name)) return { error: `属性已存在：${type.id}.${name}` }
      const id = `prop_${slug(type.id)}_${slug(name) || sha(name).slice(0, 8)}`
      db.prepare('INSERT INTO loop_ontology_props(id,type_id,name,datatype,unit,enum_json,required,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, type.id, name, datatype, payload.unit || null, JSON.stringify(payload.enum || []), payload.required ? 1 : 0, now())
      return { kind, id, type_id: type.id, name }
    }
    if (kind === 'relation') {
      const name = text(payload.name)
      const from = text(payload.from || payload.from_type)
      const to = text(payload.to || payload.to_type)
      if (!name || !from || !to) return { error: '关系候选缺少 name/from/to' }
      const ft = db.prepare('SELECT id FROM loop_ontology_types WHERE id=? OR name=? LIMIT 1').get(from, from)
      const tt = db.prepare('SELECT id FROM loop_ontology_types WHERE id=? OR name=? LIMIT 1').get(to, to)
      if (!ft || !tt) return { error: '关系候选的端点类型不存在' }
      if (db.prepare('SELECT id FROM loop_ontology_relations WHERE name=? AND from_type=? AND to_type=?').get(name, ft.id, tt.id)) return { error: '关系已存在' }
      const id = `rel_${slug(name)}_${sha(from + to).slice(0, 6)}`
      db.prepare('INSERT INTO loop_ontology_relations(id,name,from_type,to_type,description,created_at) VALUES(?,?,?,?,?,?)').run(id, name, ft.id, tt.id, text(payload.description), now())
      return { kind, id, name }
    }
    if (kind === 'state') {
      const typeName = text(payload.type || payload.type_id)
      const name = text(payload.name || payload.state)
      const transitions = Array.isArray(payload.transitions) ? payload.transitions : []
      if (!typeName || !name) return { error: '状态候选缺少 type/name' }
      const type = db.prepare('SELECT id FROM loop_ontology_types WHERE id=? OR name=? LIMIT 1').get(typeName, typeName)
      if (!type) return { error: `状态候选引用的类型不存在：${typeName}` }
      if (transitions.some((tr) => !Array.isArray(tr) || tr.length !== 2)) return { error: '状态转换必须是 [from,to] 数组' }
      const id = uid('state')
      db.prepare('INSERT INTO loop_ontology_states(id,type_id,name,transitions_json,created_at) VALUES(?,?,?,?,?)').run(id, type.id, name, JSON.stringify(transitions), now())
      return { kind, id, type_id: type.id, name }
    }
    return { error: `不支持的结构候选：${kind}` }
  }

  function collectConditionPaths(node, acc = []) {
    if (!node || typeof node !== 'object') return acc
    if (node.op === 'and' || node.op === 'or') { (node.args || []).forEach((a) => collectConditionPaths(a, acc)); return acc }
    if (node.op === 'not') return collectConditionPaths(node.arg, acc)
    if (typeof node.path === 'string') acc.push(node.path)
    return acc
  }

  function ontologyImpact(target) {
    const current = ontologyDefsSnapshot()
    const tarTypes = new Map(target.types.map((t) => [t.id, t]))
    const removedTypes = current.types.filter((t) => !tarTypes.has(t.id)).map((t) => ({ id: t.id, name: t.name }))
    const removedProps = []
    const removedStates = []
    const removedRelations = current.relations.filter((r) => !target.relations.some((x) => x.id === r.id)).map((r) => ({ id: r.id, name: r.name, from_type: r.from_type, to_type: r.to_type }))
    for (const t of current.types) {
      const tar = tarTypes.get(t.id)
      if (!tar) continue
      const tarProps = new Set((tar.props || []).map((p) => p.name))
      for (const p of t.props || []) if (!tarProps.has(p.name)) removedProps.push({ type_id: t.id, type_name: t.name, name: p.name })
      const tarStates = new Set((tar.states || []).map((x) => x.name))
      for (const st of t.states || []) if (!tarStates.has(st.name)) removedStates.push({ type_id: t.id, type_name: t.name, name: st.name })
    }
    const removedTypeIds = new Set(removedTypes.map((t) => t.id))
    const instances = removedTypeIds.size
      ? db.prepare(`SELECT id,name,type_id FROM loop_ontology_instances WHERE type_id IN (${[...removedTypeIds].map(() => '?').join(',')})`).all(...removedTypeIds)
      : []
    const instanceIds = instances.map((i) => i.id)
    const memories = instanceIds.length
      ? db.prepare(`SELECT id,text FROM loop_memories WHERE ontology_instance_id IN (${instanceIds.map(() => '?').join(',')})`).all(...instanceIds)
      : []
    const rules = []
    const propSet = new Set(target.types.flatMap((t) => (t.props || []).map((p) => `${t.id}.${p.name}`)))
    for (const row of db.prepare('SELECT id,name,conditions_json,object_type FROM loop_rules').all()) {
      const paths = collectConditionPaths(json(row.conditions_json, {}))
      const bad = paths.some((p) => {
        const [head, prop] = p.split('.')
        const type = removedTypeIds.has(head) ? head : db.prepare('SELECT type_id FROM loop_ontology_instances WHERE name=? LIMIT 1').get(head)?.type_id
        if (!type) return false
        if (removedTypeIds.has(type)) return true
        return prop && !propSet.has(`${type}.${prop}`)
      })
      if (bad || (row.object_type && removedTypeIds.has(row.object_type))) rules.push({ id: row.id, name: row.name })
    }
    const summary = { removed_types: removedTypes.length, removed_props: removedProps.length, removed_relations: removedRelations.length, removed_states: removedStates.length, instances: instances.length, memories: memories.length, rules: rules.length }
    return { summary, removed_types: removedTypes, removed_props: removedProps, removed_relations: removedRelations, removed_states: removedStates, instances, memories, rules }
  }

  function rollbackOntologyVersion(versionId, { note = '', confirmImpact = false, owner = OWNER_DEFAULT } = {}) {
    const row = db.prepare('SELECT * FROM loop_ontology_versions WHERE id=?').get(versionId)
    if (!row) return { error: '版本不存在', status: 404 }
    const current = currentOntologyVersion()
    if (current && current.id === row.id) return { error: 'already_current', status: 409, message: '该版本已经是当前版本' }
    let target
    try { target = json(row.snapshot_json, {}) } catch { return { error: 'invalid_snapshot', status: 409 } }
    const errors = validateOntologyStructure(target)
    if (errors.length) return { error: 'invalid_snapshot', status: 409, errors, message: errors.join('；') }
    const impact = ontologyImpact(target)
    const impacted = Object.values(impact.summary).some((n) => Number(n) > 0)
    if (impacted && !confirmImpact) return { error: 'rollback_has_impact', status: 409, impact, message: '回滚会影响现有实例/记忆/规则；请确认影响后重试（confirm_impact=true）' }
    const before = ontologyDefsSnapshot()
    tx(() => {
      db.exec('DELETE FROM loop_ontology_states; DELETE FROM loop_ontology_relations; DELETE FROM loop_ontology_props; DELETE FROM loop_ontology_types;')
      const insType = db.prepare('INSERT INTO loop_ontology_types(id,name,description,version,status,created_at) VALUES(?,?,?,?,?,?)')
      const insProp = db.prepare('INSERT INTO loop_ontology_props(id,type_id,name,datatype,unit,enum_json,required,created_at) VALUES(?,?,?,?,?,?,?,?)')
      const insState = db.prepare('INSERT INTO loop_ontology_states(id,type_id,name,transitions_json,created_at) VALUES(?,?,?,?,?)')
      const insRel = db.prepare('INSERT INTO loop_ontology_relations(id,name,from_type,to_type,description,created_at) VALUES(?,?,?,?,?,?)')
      for (const t of target.types) {
        insType.run(t.id, t.name, t.description || '', t.version || 1, t.status || 'published', t.created_at || now())
        for (const p of t.props || []) insProp.run(p.id, t.id, p.name, p.datatype || 'string', p.unit || null, p.enum_json || '[]', Number(p.required) || 0, p.created_at || now())
        for (const st of t.states || []) insState.run(st.id, t.id, st.name, st.transitions_json || '[]', st.created_at || now())
      }
      for (const r of target.relations || []) insRel.run(r.id, r.name, r.from_type, r.to_type, r.description || '', r.created_at || now())
      for (const inst of impact.instances) db.prepare('UPDATE loop_ontology_instances SET status=?,candidate=1,updated_at=? WHERE id=?').run('orphaned', now(), inst.id)
      for (const r of impact.rules) {
        const rule = db.prepare('SELECT * FROM loop_rules WHERE id=?').get(r.id)
        db.prepare('UPDATE loop_rules SET governance_status=?,updated_at=? WHERE id=?').run('paused', now(), r.id)
        if (rule) saveRuleVersion(rule.id, { ...ruleJson(rule), governance_status: 'paused' }, '本体回滚：条件引用的结构已不存在，自动暂停')
      }
      for (const m of impact.memories) {
        const mem = db.prepare('SELECT * FROM loop_memories WHERE id=?').get(m.id)
        if (!mem) continue
        const meta = json(mem.metadata_json, {})
        db.prepare('UPDATE loop_memories SET metadata_json=?, updated_at=? WHERE id=?').run(JSON.stringify({ ...meta, ontology_orphaned: true, ontology_orphaned_at: now() }), now(), m.id)
      }
      audit('ontology.rollback.impact', 'ontology', row.id, { target_version: row.version, summary: impact.summary })
    })
    const after = ontologyDefsSnapshot()
    const saved = saveOntologyVersion({
      action: 'rollback', before, after, note: note || `回滚到 v${row.version}`,
      operator: owner, changeSet: { rollback_to_version_id: row.id, target_version: row.version },
      affected: { instances: impact.instances.map((i) => i.id), memories: impact.memories.map((m) => m.id), rules: impact.rules.map((r) => r.id) },
    })
    audit('ontology.rollback', 'ontology', saved.id, { target_version: row.version, summary: impact.summary })
    return { version: saved.version, version_id: saved.id, target_version: row.version, impact, applied: true, note: '回滚已写入新版本；数据未删除，受影响实例标记 orphaned、规则暂停' }
  }

  function parseSub(sub) {
    const parts = String(sub || '').split('/').filter(Boolean).map(part => decodeURIComponent(part))
    return parts
  }

  function ownerFrom(url) {
    return ownerOf(url.searchParams.get('owner'))
  }
  /** 按 id 读写时 owner 可省略（单用户边界）；显式传入则强制隔离。 */
  function optionalOwner(url, key = 'owner') {
    const v = url.searchParams.get(key)
    return v ? ownerOf(v) : null
  }

  function derivedCounts(sourceId) {
    const memories = db.prepare('SELECT COUNT(*) AS n FROM loop_memories WHERE source_id=?').get(sourceId).n
    const messageIds = new Set(db.prepare('SELECT id FROM loop_messages WHERE source_id=?').all(sourceId).map((m) => m.id))
    let rules = 0
    for (const r of db.prepare('SELECT evidence_json FROM loop_rules WHERE project IS NOT NULL').all()) {
      const ev = json(r.evidence_json, [])
      if (ev.some((e) => messageIds.has(e.message_id))) rules++
    }
    return { memories, rules }
  }

  function listImports(url) {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50))
    const owner = ownerFrom(url)
    const status = text(url.searchParams.get('status'))
    const where = ['owner=?']; const args = [owner]
    if (status) { where.push('extraction_status=?'); args.push(status) }
    return db.prepare(`SELECT * FROM loop_sources WHERE ${where.join(' AND ')} ORDER BY imported_at DESC LIMIT ?`).all(...args, limit).map((s) => ({
      ...sourceJson(s),
      messages: db.prepare('SELECT COUNT(*) AS n FROM loop_messages WHERE source_id=?').get(s.id).n,
      derived: derivedCounts(s.id),
      batches: db.prepare('SELECT id,kind,status,total,done,failed,error,created_at,updated_at FROM loop_batches WHERE source_id=? ORDER BY created_at DESC LIMIT 5').all(s.id),
    }))
  }

  function importDetail(id, owner = OWNER_DEFAULT) {
    const source = db.prepare('SELECT * FROM loop_sources WHERE id=? AND owner=?').get(id, owner)
    if (!source) return null
    const messages = getMessages(id).map((m) => ({
      ...m, attachments: json(m.attachment_json, []).map((a) => ({ ...a, parsed: false })), warnings: json(m.warnings_json, []),
    }))
    const batches = db.prepare('SELECT * FROM loop_batches WHERE source_id=? ORDER BY created_at DESC, rowid DESC').all(id).map(batchJson)
    const memories = db.prepare('SELECT id,type,text,status,confirmation,protected FROM loop_memories WHERE source_id=?').all(id)
    const messageIds = new Set(messages.map((m) => m.id))
    const rules = db.prepare('SELECT id,name,governance_status,evidence_json FROM loop_rules WHERE owner=?').all(owner)
      .filter((r) => json(r.evidence_json, []).some((e) => messageIds.has(e.message_id)))
      .map((r) => ({ id: r.id, name: r.name, governance_status: r.governance_status }))
    return { source: sourceJson(source), messages, batches, derived: { memories, rules } }
  }

  function listMemories(url) {
    const where = ['owner=?']; const args = [ownerFrom(url)]
    for (const key of ['type', 'status', 'scope_type', 'sensitive']) {
      const v = url.searchParams.get(key)
      if (v) { where.push(`${key}=?`); args.push(key === 'sensitive' ? Number(v) : v) }
    }
    const sourceId = text(url.searchParams.get('source_id'))
    if (sourceId) { where.push('source_id=?'); args.push(sourceId) }
    const q = text(url.searchParams.get('q'))
    if (q) { where.push('(text LIKE ? OR subject LIKE ? OR object_value LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`) }
    const limit = Math.min(300, Math.max(1, Number(url.searchParams.get('limit')) || 100))
    const rows = db.prepare(`SELECT * FROM loop_memories WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...args, limit)
    return rows.map((r) => ({
      ...memoryJson(r),
      typeLabel: TYPE_LABEL[r.type] || r.type,
      ontology: r.ontology_instance_id ? db.prepare('SELECT id,type_id,name FROM loop_ontology_instances WHERE id=?').get(r.ontology_instance_id) : null,
      source: r.source_id ? db.prepare('SELECT id,title,platform,file_name FROM loop_sources WHERE id=?').get(r.source_id) : null,
    }))
  }

  function memoryDetail(id, owner = OWNER_DEFAULT) {
    const row = db.prepare('SELECT * FROM loop_memories WHERE id=? AND owner=?').get(id, owner)
    if (!row) return null
    const versions = db.prepare('SELECT version,text,object_value,status,note,created_at FROM loop_memory_versions WHERE memory_id=? ORDER BY version').all(id)
    const evidence = db.prepare(`SELECT e.message_id,e.quote,m.role,m.ordinal,m.original_time,m.content,m.source_id,s.title AS source_title
      FROM loop_memory_evidence e LEFT JOIN loop_messages m ON m.id=e.message_id LEFT JOIN loop_sources s ON s.id=m.source_id
      WHERE e.memory_id=?`).all(id)
    return {
      memory: {
        ...memoryJson(row),
        ontology: row.ontology_instance_id ? db.prepare('SELECT id,type_id,name FROM loop_ontology_instances WHERE id=?').get(row.ontology_instance_id) : null,
      },
      versions,
      evidence: evidence.map((e) => ({
        message_id: e.message_id, quote: e.quote, source_id: e.source_id, source_title: e.source_title,
        message: { id: e.message_id, role: e.role, ordinal: e.ordinal, original_time: e.original_time, content: e.content },
      })),
    }
  }

  function ontologySnapshot(owner = OWNER_DEFAULT) {
    const types = db.prepare('SELECT * FROM loop_ontology_types ORDER BY name').all().map((t) => ({
      ...t,
      props: db.prepare('SELECT * FROM loop_ontology_props WHERE type_id=? ORDER BY name').all(t.id).map((p) => ({ ...p, enum: json(p.enum_json, []) })),
      states: db.prepare('SELECT * FROM loop_ontology_states WHERE type_id=?').all(t.id).map((s) => ({ ...s, transitions: json(s.transitions_json, []) })),
      relationsFrom: db.prepare('SELECT id,name,from_type,to_type FROM loop_ontology_relations WHERE from_type=?').all(t.id),
    }))
    const instances = db.prepare('SELECT * FROM loop_ontology_instances WHERE owner=? ORDER BY created_at DESC').all(owner).map((i) => instanceSnapshot(i))
    const proposals = db.prepare('SELECT * FROM loop_ontology_proposals ORDER BY created_at DESC').all().map((p) => ({ ...p, payload: json(p.payload_json, {}) }))
    return { types, relations: db.prepare('SELECT * FROM loop_ontology_relations').all(), instances, proposals }
  }

  function instanceSnapshot(i) {
    const props = db.prepare(`SELECT ip.prop_id,ip.value_json,ip.updated_at,p.name,p.datatype,p.unit FROM loop_instance_props ip
      LEFT JOIN loop_ontology_props p ON p.id=ip.prop_id WHERE ip.instance_id=?`).all(i.id)
      .map((r) => ({ prop_id: r.prop_id, name: r.name || r.prop_id, datatype: r.datatype || 'string', unit: r.unit || null, value: json(r.value_json, null), updated_at: r.updated_at }))
    const relations = db.prepare(`SELECT ir.id,ir.from_id,ir.to_id,ir.relation_id,rel.name AS relation_name,rel.from_type,rel.to_type,other.name AS other_name
      FROM loop_instance_relations ir LEFT JOIN loop_ontology_relations rel ON rel.id=ir.relation_id
      LEFT JOIN loop_ontology_instances other ON other.id=CASE WHEN ir.from_id=? THEN ir.to_id ELSE ir.from_id END
      WHERE ir.from_id=? OR ir.to_id=?`).all(i.id, i.id, i.id)
    const stateHistory = db.prepare('SELECT state,from_state,reason,created_at FROM loop_state_history WHERE instance_id=? ORDER BY created_at').all(i.id)
    return {
      ...i, aliases: json(i.aliases_json, []),
      current_state: stateHistory.length ? stateHistory[stateHistory.length - 1].state : null,
      properties: props, relations, state_history: stateHistory,
    }
  }

  function instanceDetail(id, owner = OWNER_DEFAULT) {
    const row = db.prepare('SELECT * FROM loop_ontology_instances WHERE id=? AND owner=?').get(id, owner)
    return row ? instanceSnapshot(row) : null
  }

  function conditionHeads(node, acc = new Set()) {
    if (!node || typeof node !== 'object') return acc
    if (node.op === 'and' || node.op === 'or') { for (const a of node.args || []) conditionHeads(a, acc); return acc }
    if (node.op === 'not') return conditionHeads(node.arg, acc)
    if (typeof node.path === 'string') { const head = node.path.split('.')[0]; if (head) acc.add(head) }
    return acc
  }

  function latestConflictResolution(owner, key) {
    return db.prepare('SELECT * FROM loop_rule_conflict_resolutions WHERE owner=? AND conflict_key=? ORDER BY created_at DESC LIMIT 1').get(owner, key) || null
  }

  function resolveRuleConflict(conflictKey, body = {}) {
    const owner = ownerOf(body.owner)
    const resolution = text(body.resolution)
    const valid = ['prefer_a', 'prefer_b', 'keep_both', 'disable_both']
    if (!valid.includes(resolution)) return { ok: false, status: 400, error: 'invalid_resolution', message: `resolution 必须是 ${valid.join(' / ')}` }
    const conflicts = ruleConflicts(owner)
    const conflict = conflicts.find((c) => c.key === conflictKey)
    if (!conflict) return { ok: false, status: 404, error: 'conflict_not_found', message: '冲突不存在或已消失' }
    const id = uid('cres')
    db.prepare('INSERT INTO loop_rule_conflict_resolutions(id,conflict_key,owner,rule_a_id,rule_b_id,resolution,note,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, conflictKey, owner, conflict.a_id, conflict.b_id, resolution, text(body.note) || '', ownerOf(body.actor || owner), now())
    const kept = resolution === 'prefer_a' ? [conflict.a_id] : resolution === 'prefer_b' ? [conflict.b_id] : resolution === 'keep_both' ? [conflict.a_id, conflict.b_id] : []
    const excluded = [conflict.a_id, conflict.b_id].filter((id) => !kept.includes(id))
    audit('rule.conflict.resolve', 'rule_conflict', id, { conflict_key: conflictKey, resolution, kept, excluded })
    return {
      ok: true, id, conflict_key: conflictKey, resolution, note: text(body.note) || '', actor: owner,
      conflict: { key: conflict.key, a: conflict.a_id, b: conflict.b_id, reason: conflict.reason },
      applied: { kept, excluded },
      note_text: '裁决不删除规则，双方与版本保留；上下文按裁决结果执行',
    }
  }

  function ruleConflicts(owner = OWNER_DEFAULT) {
    const nowIso = now()
    const rows = db.prepare(`SELECT * FROM loop_rules WHERE owner=? AND governance_status='active'`).all(owner)
      .filter((r) => (!r.valid_to || r.valid_to > nowIso) && (!r.valid_from || r.valid_from <= nowIso))
      .map(ruleJson)
    const out = []
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i]; const b = rows[j]
        if (a.project && b.project && a.project !== b.project) continue
        const sameScope = a.scope_type === b.scope_type && String(a.scope_id || '') === String(b.scope_id || '')
        const sameObject = a.object_id && a.object_id === b.object_id
        if (!sameScope && !sameObject) continue
        const ah = conditionHeads(a.conditions); const bh = conditionHeads(b.conditions)
        const sharedHead = [...ah].some((h) => bh.has(h)) || (!ah.size && !bh.size)
        if (!sharedHead) continue
        const opposite = (['must', 'must_not'].includes(a.strength) && ['must', 'must_not'].includes(b.strength) && a.strength !== b.strength)
        const blockA = (a.actions || []).some((x) => /block|deny|forbid/.test(String(x.type || x.action || '')))
        const allowB = (b.actions || []).some((x) => /execute|allow|start|optimize|run/.test(String(x.type || x.action || '')))
        const blockB = (b.actions || []).some((x) => /block|deny|forbid/.test(String(x.type || x.action || '')))
        const allowA = (a.actions || []).some((x) => /execute|allow|start|optimize|run/.test(String(x.type || x.action || '')))
        const actionConflict = (blockA && allowB) || (blockB && allowA)
        if (!opposite && !actionConflict) continue
        const ra = a.authority_rank ?? ruleAuthority(a).rank
        const rb = b.authority_rank ?? ruleAuthority(b).rank
        const auto = ra > rb ? 'prefer_a' : rb > ra ? 'prefer_b' : 'unresolved'
        const key = [a,b].sort((x,y)=>x.id.localeCompare(y.id)).map(rule=>`${rule.id}@${rule.version}`).join('~')
        const manual = latestConflictResolution(owner, key)
        out.push({
          key, a_id: a.id, b_id: b.id, a, b,
          reason: `${opposite ? '相反强度' : '动作冲突'}：${a.name}(${a.strength}) vs ${b.name}(${b.strength})`,
          resolution: manual ? manual.resolution : auto,
          auto_resolution: auto,
          adjudicated: !!manual,
          manual: manual ? { resolution: manual.resolution, note: manual.note, actor: manual.actor, created_at: manual.created_at } : null,
          unresolved: !manual && auto === 'unresolved',
          precedence: {
            a: { id: a.id, authority: a.authority, rank: ra },
            b: { id: b.id, authority: b.authority, rank: rb },
          },
        })
      }
    }
    return out
  }

  function listRules(url) {
    const owner = ownerFrom(url)
    const where = ['owner=?']; const args = [owner]
    const status = url.searchParams.get('status')
    if (status) { where.push('governance_status=?'); args.push(status) }
    const view = text(url.searchParams.get('view')) || 'all'
    const nowIso = now()
    let rows = db.prepare(`SELECT * FROM loop_rules WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 300`).all(...args).map(ruleJson)
    const conflicts = ruleConflicts(owner)
    const byId = new Map()
    for (const c of conflicts) {
      if (!byId.has(c.a_id)) byId.set(c.a_id, [])
      if (!byId.has(c.b_id)) byId.set(c.b_id, [])
      byId.get(c.a_id).push({ with: c.b_id, reason: c.reason, resolution: c.resolution === 'prefer_a' ? 'this_wins' : c.resolution === 'prefer_b' ? 'other_wins' : 'unresolved' })
      byId.get(c.b_id).push({ with: c.a_id, reason: c.reason, resolution: c.resolution === 'prefer_b' ? 'this_wins' : c.resolution === 'prefer_a' ? 'other_wins' : 'unresolved' })
    }
    rows = rows.map((r) => ({ ...r, conflicts: byId.get(r.id) || [] }))
    if (view === 'conflicts') rows = rows.filter((r) => r.conflicts.length)
    if (view === 'unstructured') rows = rows.filter((r) => r.structure_status !== 'structured')
    return rows.map((r) => ({ ...r, categoryLabel: RULE_CATEGORIES_LABEL[r.category] || r.category }))
  }

  function ruleDetail(id, owner = OWNER_DEFAULT) {
    const row = db.prepare('SELECT * FROM loop_rules WHERE id=? AND owner=?').get(id, owner)
    if (!row) return null
    const rule = ruleJson(row)
    const versions = db.prepare('SELECT version,payload_json,note,created_at FROM loop_rule_versions WHERE rule_id=? ORDER BY created_at').all(id)
      .map((v) => ({ ...v, payload: json(v.payload_json, {}) }))
    const all = ruleConflicts(owner).filter((c) => c.a_id === id || c.b_id === id)
    const ids = new Set((rule.evidence || []).map((e) => e.message_id))
    const evidenceMessages = ids.size ? db.prepare(`SELECT m.id AS message_id,e.quote,m.role,m.original_time,m.source_id,s.title AS source_title
      FROM loop_messages m LEFT JOIN loop_sources s ON s.id=m.source_id
      LEFT JOIN loop_memory_evidence e ON e.message_id=m.id
      WHERE m.id IN (${[...ids].map(() => '?').join(',')})`).all(...ids) : []
    return { rule, versions, conflicts: all, evidence_messages: evidenceMessages }
  }

  function saveRuleVersion(ruleId, payload, note = '') {
    db.prepare('INSERT INTO loop_rule_versions(id,rule_id,version,payload_json,note,created_at) VALUES(?,?,?,?,?,?)')
      .run(uid('rv'), ruleId, Number(payload.version) || 1, JSON.stringify(payload), String(note || ''), now())
  }

  function simulateRule(rule, context) {
    const evals = []
    const event = text(context.event || context.trigger_event || context.action?.type)
    if (rule.trigger_event && rule.trigger_event !== event) return { rule_id: rule.id, result: event ? 'not_applicable' : 'unknown', reason: event ? '触发事件不匹配' : '缺少触发事件', conditions: evals }
    const walk = (node, label = '条件') => {
      const r = evaluateCondition(node, context)
      evals.push({ label, op: node?.op ?? null, path: node?.path ?? null, value: node?.value, result: r.value, unknown: r.unknown, reason: r.reason })
      if (node?.op === 'and' || node?.op === 'or') (node.args || []).forEach((a, i) => walk(a, `args[${i}]`))
      else if (node?.op === 'not') walk(node.arg, 'arg')
    }
    if (rule.structure_status !== 'structured' || !rule.conditions || !Object.keys(rule.conditions).length) {
      return { rule_id: rule.id, result: 'unknown', reason: '规则尚未结构化，需人工整理后才能自动评估', conditions: evals }
    }
    walk(rule.conditions)
    const unknown = evals.some((e) => e.unknown)
    const value = evalConditionValue(rule.conditions, context)
    if (value) {
      for (const exception of rule.exceptions || []) {
        const node = exception?.conditions || exception?.condition || exception
        if (!node || typeof node !== 'object' || !node.op) return { rule_id: rule.id, result: 'unknown', reason: '例外条件尚未结构化', conditions: evals }
        const result = evaluateCondition(node, context)
        if (result.unknown) return { rule_id: rule.id, result: 'unknown', reason: `例外条件未知：${result.reason}`, conditions: evals }
        if (result.value) return { rule_id: rule.id, result: 'not_applicable', reason: '例外条件命中', conditions: evals }
      }
    }
    return { rule_id: rule.id, result: value ? 'applicable' : unknown ? 'unknown' : 'not_applicable', reason: evals.map((e) => e.reason).join('; '), conditions: evals }
  }

  function evalConditionValue(node, context) {
    if (node.op === 'and') return (node.args || []).every((a) => { const r = evaluateCondition(a, context); return !r.unknown && r.value })
    if (node.op === 'or') return (node.args || []).some((a) => { const r = evaluateCondition(a, context); return !r.unknown && r.value })
    if (node.op === 'not') { const r = evaluateCondition(node.arg, context); return !r.unknown && !r.value }
    const r = evaluateCondition(node, context)
    return !r.unknown && r.value
  }

  /* ---------------------------------------------------------------- 工具：规则 */

  function persistRule(f = {}) {
    const id = uid('rule')
    const authority = ruleAuthority({ ...f, id })
    db.prepare(`INSERT INTO loop_rules(id,name,description,category,scope_type,scope_id,owner,project,task,object_type,object_id,trigger_event,conditions_json,actions_json,strength,exceptions_json,acceptance,source_category,evidence_json,confidence,confirmation,valid_from,valid_to,governance_status,version,supersedes_id,structure_status,created_at,updated_at,structure_errors_json,feedback_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, text(f.name) || '未命名规则', text(f.description) || '', RULE_CATEGORIES.includes(f.category) ? f.category : 'business_constraint',
      SCOPES.includes(f.scope_type) ? f.scope_type : 'personal', f.scope_id || null, ownerOf(f.owner), f.project || null, f.task || null,
      f.object_type || null, f.object_id || null, f.trigger_event || null,
      JSON.stringify(f.conditions && typeof f.conditions === 'object' ? f.conditions : {}),
      JSON.stringify(Array.isArray(f.actions) ? f.actions : []),
      STRENGTHS.includes(f.strength) ? f.strength : 'prefer', JSON.stringify(Array.isArray(f.exceptions) ? f.exceptions : []),
      text(f.acceptance) || '', SOURCE_CATEGORIES.includes(f.source_category) ? f.source_category : 'user_confirmation',
      JSON.stringify(Array.isArray(f.evidence) ? f.evidence : []), Number.isFinite(Number(f.confidence)) ? Number(f.confidence) : 0.8,
      f.confirmation || 'candidate', f.valid_from || null, f.valid_to || null,
      GOVERNANCE.includes(f.governance_status) ? f.governance_status : 'candidate', 1, f.supersedes_id || null,
      f.structure_status || 'structured', now(), now(), JSON.stringify(f.structure_errors || []), f.feedback_id || null)
    const row = db.prepare('SELECT * FROM loop_rules WHERE id=?').get(id)
    saveRuleVersion(id, { ...ruleJson(row), authority }, f.note || '创建规则')
    audit('rule.create', 'rule', id, { authority: authority.key, supersedes_id: f.supersedes_id || null })
    return row
  }

  function importLegacyRule(rule) {
    const previous = db.prepare("SELECT id FROM loop_rules WHERE json_extract(evidence_json,'$[0].legacy_rule_id')=? AND owner=?").get(String(rule.id),OWNER_DEFAULT)
    if (previous) return previous.id
    return tx(() => persistRule({
      owner:OWNER_DEFAULT,name:text(rule.action).slice(0,80),description:[text(rule.condition),text(rule.action)].filter(Boolean).join('：'),
      category:rule.type==='preference'?'personal_preference':rule.type==='workflow'?'workflow':'business_constraint',
      scope_type:'personal',strength:rule.type==='boundary'?'must_not':'prefer',source_category:'reference',
      governance_status:'candidate',confirmation:'candidate',structure_status:'unstructured',conditions:{},actions:[],
      evidence:[{legacy_rule_id:String(rule.id),source:rule.evidence?.source||'legacy rules.json',quote:text(rule.evidence?.quote)}],
      note:'由旧规则库迁入；补齐结构化条件和动作并审核后生效',
    }).id)
  }
  function withdrawLegacyRule(id) {
    db.prepare("UPDATE loop_rules SET governance_status='paused',updated_at=? WHERE owner=? AND json_extract(evidence_json,'$[0].legacy_rule_id')=?").run(now(),OWNER_DEFAULT,String(id))
  }

  function updateRuleRow(id, f, note = '') {
    db.prepare(`UPDATE loop_rules SET name=?,description=?,category=?,scope_type=?,scope_id=?,owner=?,project=?,task=?,object_type=?,object_id=?,trigger_event=?,conditions_json=?,actions_json=?,strength=?,exceptions_json=?,acceptance=?,source_category=?,evidence_json=?,confidence=?,confirmation=?,valid_from=?,valid_to=?,governance_status=?,version=?,supersedes_id=?,structure_status=?,updated_at=?,structure_errors_json=?,feedback_id=? WHERE id=?`).run(
      text(f.name) || '未命名规则', text(f.description) || '', RULE_CATEGORIES.includes(f.category) ? f.category : 'business_constraint',
      SCOPES.includes(f.scope_type) ? f.scope_type : 'personal', f.scope_id || null, ownerOf(f.owner), f.project || null, f.task || null,
      f.object_type || null, f.object_id || null, f.trigger_event || null,
      JSON.stringify(f.conditions && typeof f.conditions === 'object' ? f.conditions : {}),
      JSON.stringify(Array.isArray(f.actions) ? f.actions : []),
      STRENGTHS.includes(f.strength) ? f.strength : 'prefer', JSON.stringify(Array.isArray(f.exceptions) ? f.exceptions : []),
      text(f.acceptance) || '', SOURCE_CATEGORIES.includes(f.source_category) ? f.source_category : 'user_confirmation',
      JSON.stringify(Array.isArray(f.evidence) ? f.evidence : []), Number.isFinite(Number(f.confidence)) ? Number(f.confidence) : 0.8,
      f.confirmation || 'candidate', f.valid_from || null, f.valid_to || null,
      GOVERNANCE.includes(f.governance_status) ? f.governance_status : 'candidate', Number(f.version) || 1,
      f.supersedes_id || null, f.structure_status || 'structured', now(), JSON.stringify(f.structure_errors || []), f.feedback_id || null, id)
    const row = db.prepare('SELECT * FROM loop_rules WHERE id=?').get(id)
    saveRuleVersion(id, ruleJson(row), note)
    audit('rule.update', 'rule', id, { version: row.version })
    return row
  }

  function fieldsFromRule(row) {
    const r = ruleJson(row)
    return {
      ...r, conditions: r.conditions, actions: r.actions, exceptions: r.exceptions, evidence: r.evidence,
      source_category: row.source_category, confirmation: row.confirmation, version: row.version,
    }
  }

  /* ---------------------------------------------------------------- 工具：本体 */

  function findInstance(idOrName, owner = OWNER_DEFAULT) {
    return db.prepare('SELECT * FROM loop_ontology_instances WHERE owner=? AND (id=? OR name=?) LIMIT 1').get(owner, idOrName, idOrName)
  }

  function checkValue(prop, value, unit) {
    const errors = []
    let converted = null
    let out = value
    if (prop.datatype === 'number') {
      const n = Number(value)
      if (!Number.isFinite(n)) errors.push(`属性 ${prop.name} 需要数值`)
      else out = n
    } else if (prop.datatype === 'boolean') {
      if (typeof value !== 'boolean') errors.push(`属性 ${prop.name} 需要布尔值`)
    } else if (prop.datatype === 'date') {
      const t = parseTime(value)
      if (!t) errors.push(`属性 ${prop.name} 需要合法日期`) ; else out = t
    } else {
      if (typeof value !== 'string' || !value.trim()) errors.push(`属性 ${prop.name} 需要非空字符串`)
    }
    const enums = json(prop.enum_json, [])
    if (!errors.length && enums.length && !enums.includes(out)) errors.push(`属性 ${prop.name} 只允许：${enums.join(' / ')}`)
    if (!errors.length && prop.unit && unit && unit !== prop.unit) {
      const direct = UNIT_CONVERSIONS[unit]
      const inverse = UNIT_CONVERSIONS[prop.unit]
      if (direct && direct.to === prop.unit && prop.datatype === 'number') {
        out = Number((Number(out) * direct.factor).toFixed(6))
        converted = { from: unit, to: prop.unit, factor: direct.factor, original: value, value: out }
      } else if (inverse && inverse.to === unit && prop.datatype === 'number') {
        out = Number((Number(out) / inverse.factor).toFixed(6))
        converted = { from: unit, to: prop.unit, factor: 1 / inverse.factor, original: value, value: out }
      } else {
        return { ok: false, error: 'unit_conflict', expected: prop.unit, got: unit, message: `单位不一致：本体要求 ${prop.unit}，收到 ${unit}，且无法自动换算` }
      }
    }
    if (errors.length) return { ok: false, error: 'type_mismatch', message: errors.join('；'), expected: prop.datatype, got: typeof value }
    return { ok: true, value: out, converted }
  }

  function setInstanceProp(instance, body) {
    const prop = body.prop_id
      ? db.prepare('SELECT * FROM loop_ontology_props WHERE id=? AND type_id=?').get(body.prop_id, instance.type_id)
      : db.prepare('SELECT * FROM loop_ontology_props WHERE type_id=? AND name=?').get(instance.type_id, text(body.name || body.prop))
    if (!prop) return { ok: false, status: 409, error: 'unknown_property', message: '属性未在本体定义中；请先提交结构变更候选，不能直接改正式本体' }
    const checked = checkValue(prop, body.value, body.unit)
    if (!checked.ok) return { ok: false, status: 409, ...checked }
    db.prepare('INSERT INTO loop_instance_props(instance_id,prop_id,value_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(instance_id,prop_id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at')
      .run(instance.id, prop.id, JSON.stringify(checked.value), now())
    db.prepare('INSERT INTO loop_instance_prop_history(id,instance_id,prop_id,value_json,unit,source,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(uid('iph'), instance.id, prop.id, JSON.stringify(checked.value), prop.unit || body.unit || null, 'manual', now())
    db.prepare('UPDATE loop_ontology_instances SET updated_at=? WHERE id=?').run(now(), instance.id)
    audit('ontology.instance.prop', 'instance', instance.id, { prop: prop.name, value: checked.value, unit: prop.unit || null })
    return { ok: true, prop: { id: prop.id, name: prop.name, datatype: prop.datatype, unit: prop.unit || null }, value: checked.value, converted: checked.converted }
  }

  function setInstanceRelation(instance, body, owner = OWNER_DEFAULT) {
    const rel = body.relation_id ? db.prepare('SELECT * FROM loop_ontology_relations WHERE id=?').get(body.relation_id) : db.prepare('SELECT * FROM loop_ontology_relations WHERE name=? LIMIT 1').get(text(body.name || body.relation))
    if (!rel) return { ok: false, status: 409, error: 'unknown_relation', message: '关系未在本体定义中；请先提交结构变更候选' }
    const to = findInstance(body.to_instance_id || body.to_name || body.to, owner)
    if (!to) return { ok: false, status: 404, error: 'instance_not_found', message: '目标实例不存在' }
    if (rel.from_type !== instance.type_id || rel.to_type !== to.type_id) {
      return { ok: false, status: 409, error: 'relation_endpoint_mismatch', message: `关系 ${rel.name} 要求 ${rel.from_type} → ${rel.to_type}，实际 ${instance.type_id} → ${to.type_id}` }
    }
    const exists = db.prepare('SELECT id FROM loop_instance_relations WHERE from_id=? AND relation_id=? AND to_id=?').get(instance.id, rel.id, to.id)
    if (!exists) db.prepare('INSERT INTO loop_instance_relations(id,from_id,relation_id,to_id,created_at) VALUES(?,?,?,?,?)').run(uid('irel'), instance.id, rel.id, to.id, now())
    audit('ontology.instance.relation', 'instance', instance.id, { relation: rel.name, to: to.id })
    return { ok: true, relation: { id: rel.id, name: rel.name }, to: { id: to.id, name: to.name, type_id: to.type_id } }
  }

  function setInstanceState(instance, body) {
    const target = text(body.state)
    if (!target) return { ok: false, status: 400, error: 'state_required', message: '缺少目标状态' }
    const defs = db.prepare('SELECT * FROM loop_ontology_states WHERE type_id=?').all(instance.type_id).map((s) => json(s.transitions_json, []))
    const transitions = defs.flat()
    const known = new Set(transitions.flat())
    const current = db.prepare('SELECT state FROM loop_state_history WHERE instance_id=? ORDER BY created_at DESC LIMIT 1').get(instance.id)?.state || null
    if (!current && known.size) {
      // 初始状态：允许设置为本体定义中出现过的状态。
      if (!known.has(target)) return { ok: false, status: 409, error: 'illegal_transition', from: null, to: target, message: `未知状态：${target}` }
    } else {
      const check = validateTransition(transitions, current, target)
      if (!check.ok) return { ok: false, status: 409, error: 'illegal_transition', from: current, to: target, message: check.reason }
    }
    db.prepare('INSERT INTO loop_state_history(id,instance_id,state,from_state,reason,created_at) VALUES(?,?,?,?,?,?)').run(uid('st'), instance.id, target, current, text(body.reason) || '人工设置', now())
    db.prepare('UPDATE loop_ontology_instances SET updated_at=? WHERE id=?').run(now(), instance.id)
    audit('ontology.instance.state', 'instance', instance.id, { from: current, to: target })
    return { ok: true, from: current, to: target }
  }

  /* ---------------------------------------------------------------- 工具：来源/记忆 */

  function evidenceIsLive(evidence, owner) {
    return !!db.prepare(`SELECT m.id FROM loop_messages m JOIN loop_sources s ON s.id=m.source_id
      WHERE m.id=? AND s.owner=? AND s.archived_at IS NULL`).get(evidence.message_id, owner)
  }

  function archiveSource(source, owner) {
    if (source.owner !== owner) return null
    const messages = getMessages(source.id)
    const msgIds = new Set(messages.map((m) => m.id))
    db.prepare('UPDATE loop_sources SET archived_at=?, extraction_status=? WHERE id=?').run(now(), 'archived', source.id)
    db.prepare("UPDATE loop_jobs SET cancel_requested=1,status='cancelled',lease_owner=NULL,lease_until=NULL,finished_at=?,updated_at=? WHERE source_id=? AND status IN ('queued','running')").run(now(),now(),source.id)
    let memories = 0, rules = 0
    for (const m of db.prepare('SELECT id,source_id FROM loop_memories WHERE owner=?').all(owner)) {
      const evidence = db.prepare('SELECT message_id FROM loop_memory_evidence WHERE memory_id=?').all(m.id)
      if (m.source_id !== source.id && !evidence.some((e) => msgIds.has(e.message_id))) continue
      const stillValid = evidence.some((e) => evidenceIsLive(e, owner))
      if (!stillValid) {
        db.prepare('UPDATE loop_memories SET status=?, updated_at=?, protected=0 WHERE id=? AND status<>\'superseded\'').run('archived', now(), m.id)
        memories++
      }
    }
    for (const r of db.prepare('SELECT * FROM loop_rules WHERE owner=?').all(owner)) {
      const ev = json(r.evidence_json, [])
      if (!ev.length) continue
      if (ev.some((e) => msgIds.has(e.message_id)) && !ev.some((e) => evidenceIsLive(e, owner))) {
        db.prepare('UPDATE loop_rules SET governance_status=?, updated_at=? WHERE id=?').run('paused', now(), r.id)
        rules++
      }
    }
    audit('source.archive', 'source', source.id, { memories, rules })
    return { sources: 1, memories, rules }
  }

  function snapshotMemoryRow(mem, note) {
    if (!mem) return
    db.prepare('INSERT INTO loop_memory_versions(id,memory_id,version,text,object_value,status,note,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(uid('mv'), mem.id, mem.version, mem.text, mem.object_value ?? null, mem.status, note || '', now())
  }

  /* ---------------------------------------------------------------- 工具：Skill */

  function skillMarkdown(skill) {
    const lines = [`# ${skill.name}`, '', `- 状态：${skill.status}`, `- 来源：${skill.source}`, `- 版本：v${skill.version}`, '']
    lines.push('## 适用场景', skill.scenario || '（未填写）', '')
    if (skill.inputs.length) lines.push('## 输入', ...skill.inputs.map((x) => `- ${x}`), '')
    if (skill.preconditions.length) lines.push('## 前置条件', ...skill.preconditions.map((x) => `- ${x}`), '')
    lines.push('## 执行步骤', ...(skill.steps.length ? skill.steps.map((x, i) => `${i + 1}. ${x.text}`) : ['（未填写）']), '')
    if (skill.exceptions.length) lines.push('## 异常与回退', ...skill.exceptions.map((x) => `- ${x}`), '')
    if (skill.boundaries.length) lines.push('## 边界', ...skill.boundaries.map((x) => `- ${x}`), '')
    if (skill.acceptance) lines.push('## 验收标准', skill.acceptance, '')
    if (skill.output_format) lines.push('## 输出格式', skill.output_format, '')
    lines.push('## 证据', ...(skill.evidence.length ? skill.evidence.map((e) => `- [${e.memory_id}] ${e.quote}`) : ['- （无）']))
    return lines.join('\n')
  }

  function deriveSkills(owner = OWNER_DEFAULT, project = '', minMemories = 2) {
    const methods = db.prepare(`SELECT * FROM loop_memories WHERE owner=? AND type='method' AND status='confirmed' AND IFNULL(project,'')=? ORDER BY created_at LIMIT 100`).all(owner,project || '')
    const groups = new Map()
    for (const m of methods) {
      const p = m.project || project || ''
      const key = `${m.scope_type}|${m.scope_id || ''}|${p}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(m)
    }
    const created = []
    for (const [key, rows] of groups) {
      if (rows.length < Math.max(2, Number(minMemories) || 2)) continue
      const ids = rows.map((r) => r.id)
      const exists = db.prepare(`SELECT id FROM loop_skill_candidates WHERE owner=? AND source_memory_ids_json=?`).get(owner, JSON.stringify(ids))
      if (exists) continue
      const [scopeType, scopeId, proj] = key.split('|')
      const constraints = db.prepare(`SELECT * FROM loop_memories WHERE owner=? AND type='constraint' AND status='confirmed' AND scope_type=? AND IFNULL(scope_id,'')=? AND IFNULL(project,'')=?`).all(owner, scopeType, scopeId,proj)
      const evidence = []
      for (const r of rows) for (const e of db.prepare('SELECT message_id,quote FROM loop_memory_evidence WHERE memory_id=?').all(r.id)) evidence.push({ memory_id: r.id, message_id: e.message_id, quote: e.quote })
      const id = uid('skill')
      const name = `流程候选 · ${proj || scopeId || rows[0].subject || '未命名'}`
      const steps = rows.map((r, i) => ({ order: i + 1, text: r.text, memory_id: r.id }))
      const inputs = [...new Set(rows.map((r) => r.subject).filter(Boolean))]
      db.prepare(`INSERT INTO loop_skill_candidates(id,owner,project,name,scenario,inputs_json,preconditions_json,steps_json,exceptions_json,boundaries_json,acceptance,output_format,evidence_json,source_memory_ids_json,source,status,version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, owner, proj || null, name, `同一范围内已有多条方法记忆（${rows.length} 条），可作为可复用流程候选。`,
        JSON.stringify(inputs), JSON.stringify(constraints.map((c) => c.text)), JSON.stringify(steps), '[]',
        JSON.stringify(['第一阶段只生成候选，不自动安装或执行 Skill']), '按步骤完成，并能回到每条方法记忆的证据', 'Markdown',
        JSON.stringify(evidence), JSON.stringify(ids), 'deterministic', 'candidate', 1, now(), now())
      created.push(id)
    }
    return created
  }

  function listSkills(url) {
    const owner = ownerFrom(url)
    const where = ['owner=?']; const args = [owner]
    const status = text(url.searchParams.get('status'))
    if (status) { where.push('status=?'); args.push(status) }
    return db.prepare(`SELECT * FROM loop_skill_candidates WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 100`).all(...args).map(skillJson)
  }

  /* ---------------------------------------------------------------- 工具：图谱/搜索 */

  function graphData(owner = OWNER_DEFAULT, project = '', limit = 200) {
    const nodes = []; const edges = []
    const memories = db.prepare(`SELECT * FROM loop_memories WHERE owner=? AND status NOT IN ('deleted','superseded') ${project ? "AND (project=? OR project IS NULL)" : ''} ORDER BY created_at DESC LIMIT ?`).all(...(project ? [owner, project, limit] : [owner, limit]))
    const instances = db.prepare('SELECT * FROM loop_ontology_instances WHERE owner=? ORDER BY created_at DESC LIMIT ?').all(owner, Math.max(20, Math.floor(limit / 3)))
    const rules = db.prepare('SELECT * FROM loop_rules WHERE owner=? ORDER BY updated_at DESC LIMIT ?').all(owner, Math.max(20, Math.floor(limit / 3)))
    const degree = new Map()
    const addDegree = (id, n = 1) => degree.set(id, (degree.get(id) || 0) + n)
    const memNodeIds = new Map()
    for (const m of memories) {
      const id = `m:${m.id}`; memNodeIds.set(m.id, id)
      nodes.push({ id, name: m.text.length > 48 ? `${m.text.slice(0, 48)}…` : m.text, type: 'memory', subtype: m.type, meta: { status: m.status, confirmation: m.confirmation, protected: !!m.protected, sensitive: !!m.sensitive, scope: `${m.scope_type}/${m.scope_id || 'all'}` } })
      if (m.ontology_instance_id) { const oid = `o:${m.ontology_instance_id}`; edges.push({ src: id, dst: oid, kind: 'mapped_to', label: '映射', weight: 1 }); addDegree(id); addDegree(oid) }
      if (m.supersedes_id) { const old = `m:${m.supersedes_id}`; edges.push({ src: id, dst: old, kind: 'supersedes', label: '替代', weight: 1.2 }); addDegree(id); addDegree(old) }
    }
    const objNodeIds = new Set()
    for (const i of instances) {
      const id = `o:${i.id}`; objNodeIds.add(id)
      const state = db.prepare('SELECT state FROM loop_state_history WHERE instance_id=? ORDER BY created_at DESC LIMIT 1').get(i.id)?.state || null
      nodes.push({ id, name: i.name, type: 'object', subtype: i.type_id, meta: { current_state: state, candidate: !!i.candidate, project: i.project } })
    }
    for (const r of rules) {
      const id = `r:${r.id}`
      nodes.push({ id, name: r.name, type: 'rule', subtype: r.category, meta: { governance_status: r.governance_status, strength: r.strength, authority: ruleAuthority(r).key } })
      const ev = json(r.evidence_json, [])
      const seen = new Set()
      for (const e of ev) {
        const mem = db.prepare('SELECT memory_id FROM loop_memory_evidence WHERE message_id=?').all(e.message_id)
        for (const mm of mem) {
          const target = memNodeIds.get(mm.memory_id)
          if (target && !seen.has(target)) { seen.add(target); edges.push({ src: id, dst: target, kind: 'supported_by', label: '证据', weight: 1.1 }); addDegree(id); addDegree(target) }
        }
      }
    }
    for (const rel of db.prepare('SELECT * FROM loop_instance_relations').all()) {
      const a = `o:${rel.from_id}`; const b = `o:${rel.to_id}`
      if (objNodeIds.has(a) && objNodeIds.has(b)) { const name = db.prepare('SELECT name FROM loop_ontology_relations WHERE id=?').get(rel.relation_id)?.name || '关系'; edges.push({ src: a, dst: b, kind: 'relation', label: name, weight: 1.3 }); addDegree(a); addDegree(b) }
    }
    const nodeIds = new Set(nodes.map((n) => n.id))
    const cleanEdges = edges.filter((e) => nodeIds.has(e.src) && nodeIds.has(e.dst))
    for (const n of nodes) n.degree = degree.get(n.id) || 0
    return { nodes, edges: cleanEdges, counts: { nodes: nodes.length, edges: cleanEdges.length, memories: memories.length, objects: instances.length, rules: rules.length } }
  }

  function searchLoop(owner, q, limit = 12) {
    const query = text(q); if (!query) return { items: [], total: 0 }
    const like = `%${query}%`
    const items = []
    for (const m of db.prepare(`SELECT * FROM loop_memories WHERE owner=? AND status NOT IN ('deleted','superseded') AND (text LIKE ? OR subject LIKE ? OR object_value LIKE ?) LIMIT 50`).all(owner, like, like, like)) {
      const score = m.text === query ? 3 : m.text.startsWith(query) ? 2 : 1
      items.push({ id: m.id, kind: 'memory', title: m.text.slice(0, 80), snippet: m.text.slice(0, 160), score, status: m.status, sensitive: !!m.sensitive })
    }
    for (const r of db.prepare('SELECT * FROM loop_rules WHERE owner=? AND (name LIKE ? OR description LIKE ?) LIMIT 30').all(owner, like, like)) {
      items.push({ id: r.id, kind: 'rule', title: r.name, snippet: r.description.slice(0, 160), score: r.name === query ? 3 : 1.5, status: r.governance_status })
    }
    for (const i of db.prepare('SELECT * FROM loop_ontology_instances WHERE owner=? AND name LIKE ? LIMIT 30').all(owner, like)) {
      items.push({ id: i.id, kind: 'object', title: i.name, snippet: `${i.type_id}${i.candidate ? ' · 候选' : ''}`, score: i.name === query ? 3 : 1.4 })
    }
    items.sort((a, b) => b.score - a.score)
    return { items: items.slice(0, Math.min(50, Math.max(1, Number(limit) || 12))), total: items.length }
  }

  /* ---------------------------------------------------------------- 工具：反馈演进 */

  const runOwner = (row) => row ? ownerOf(json(row.request_json, {}).owner) : null
  const feedbackOwner = (row) => row.run_id
    ? runOwner(db.prepare('SELECT request_json FROM loop_runs WHERE id=?').get(row.run_id))
    : ownerOf(json(row.correction_json, {}).owner)

  function submitFeedback(body = {}) {
    return tx(() => {
      const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
      const run = body.run_id ? db.prepare('SELECT request_json FROM loop_runs WHERE id=?').get(body.run_id) : null
      if (body.run_id && !run) fail('NOT_FOUND', '运行不存在')
      const owner = body.owner ? ownerOf(body.owner) : runOwner(run) || OWNER_DEFAULT
      if (run && runOwner(run) !== owner) fail('FORBIDDEN', '无权反馈该运行')
      for (const [key, table] of [['rule_id', 'loop_rules'], ['memory_id', 'loop_memories'], ['instance_id', 'loop_ontology_instances']]) {
        if (!body[key]) continue
        const row = db.prepare(`SELECT owner FROM ${table} WHERE id=?`).get(body[key])
        if (!row) fail('NOT_FOUND', '反馈目标不存在')
        if (row.owner !== owner) fail('FORBIDDEN', '无权反馈该目标')
      }
      const id = uid('fb')
      db.prepare('INSERT INTO loop_feedback(id,run_id,outcome,feedback,correction_json,created_at) VALUES(?,?,?,?,?,?)').run(id, body.run_id || null, text(body.outcome) || 'unknown', text(body.feedback), JSON.stringify({ ...(body.correction || {}), owner, category: body.category || null, rule_id: body.rule_id || null, memory_id: body.memory_id || null, instance_id: body.instance_id || null }), now())
      const applied = applyFeedback({ ...body, owner }, id)
      return { ok: true, id, applied, note: applied ? '已记录纠正；规则候选需人工确认后才替代生效版本' : '已记录；该类别不自动修改规则内容' }
    })
  }

  function applyFeedback(body, id) {
    const category = text(body.category)
    const owner = body.owner ? ownerOf(body.owner) : null
    const correction = body.correction && typeof body.correction === 'object' ? body.correction : {}
    let applied = null
    if (['rule_content', 'rule_scope'].includes(category) && body.rule_id) {
      const old = owner ? db.prepare('SELECT * FROM loop_rules WHERE id=? AND owner=?').get(body.rule_id, owner) : db.prepare('SELECT * FROM loop_rules WHERE id=?').get(body.rule_id)
      if (old) {
        const fields = { ...fieldsFromRule(old), ...(correction.fields || {}), owner: old.owner, source_category: 'user_confirmation', confirmation: 'candidate', governance_status: 'candidate', supersedes_id: old.id, note: `反馈演进：${text(body.feedback).slice(0, 120) || category}`, feedback_id: id }
        if (correction.text && !correction.fields?.description) fields.description = text(correction.text)
        const row = persistRule(fields)
        applied = { kind: 'rule_candidate', id: row.id, supersedes_id: old.id }
      }
    } else if (category === 'state' && body.memory_id && correction.text) {
      const old = owner ? db.prepare('SELECT * FROM loop_memories WHERE id=? AND owner=?').get(body.memory_id, owner) : db.prepare('SELECT * FROM loop_memories WHERE id=?').get(body.memory_id)
      if (old) {
        const nid = uid('mem'); const upd = now()
        snapshotMemoryRow(old, '反馈纠正前快照')
        db.prepare(`INSERT INTO loop_memories(id,source_id,type,text,subject,predicate,object_value,normalized_key,scope_type,scope_id,owner,project,task,source_category,confirmation,certainty,status,recorded_at,version,supersedes_id,confidence,sensitive,metadata_json,created_at,updated_at,protected,parent_memory_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          nid, old.source_id, old.type, text(correction.text), old.subject, old.predicate, text(correction.text),
          sha([old.type, old.subject, old.predicate, correction.text, old.scope_type, old.scope_id].join('|')),
          old.scope_type, old.scope_id, old.owner, old.project, old.task, 'user_confirmation', 'confirmed', 0.95, 'confirmed',
          upd, (old.version || 1) + 1, old.id, 0.95, old.sensitive, JSON.stringify({ feedback_id: id, correction: true }), upd, upd, 1, old.id)
        for (const e of db.prepare('SELECT message_id,quote FROM loop_memory_evidence WHERE memory_id=?').all(old.id)) db.prepare('INSERT OR IGNORE INTO loop_memory_evidence(memory_id,message_id,quote) VALUES(?,?,?)').run(nid, e.message_id, e.quote)
        db.prepare('UPDATE loop_memories SET status=?, protected=1, updated_at=? WHERE id=?').run('superseded', upd, old.id)
        applied = { kind: 'memory_correction', id: nid, supersedes_id: old.id }
      }
    } else if (category === 'state' && body.instance_id && correction.state) {
      const inst = owner ? db.prepare('SELECT * FROM loop_ontology_instances WHERE id=? AND owner=?').get(body.instance_id, owner) : db.prepare('SELECT * FROM loop_ontology_instances WHERE id=?').get(body.instance_id)
      if (inst) {
        const out = setInstanceState(inst, { state: correction.state, reason: `反馈：${text(body.feedback)}` })
        if (out.ok) applied = { kind: 'state_change', id: inst.id, to: out.to }
      }
    }
    // not_executed / tool_failure：只记录，不自动降低规则有效性或改变规则内容。
    audit('feedback.record', 'feedback', id, { outcome: body.outcome || 'unknown', category: category || null, applied_kind: applied?.kind || null })
    return applied
  }

  /* ---------------------------------------------------------------- 路由 */

  async function handle(req, res, url, sub) {
    const parts = parseSub(sub)
    const method = req.method || 'GET'
    const q = (k) => url.searchParams.get(k)
    const queryOwner = () => ownerFrom(url)
    try {
      /* ---- 概览 ---- */
      if (method === 'GET' && (!parts.length || parts[0] === 'overview')) {
        const owner = queryOwner()
        const one = (sql, ...args) => db.prepare(sql).get(...args)?.n || 0
        const counts = {
          sources: one('SELECT COUNT(*) AS n FROM loop_sources WHERE owner=?', owner),
          messages: one('SELECT COUNT(*) AS n FROM loop_messages WHERE source_id IN (SELECT id FROM loop_sources WHERE owner=?)', owner),
          memories: one('SELECT COUNT(*) AS n FROM loop_memories WHERE owner=?', owner),
          rules: one('SELECT COUNT(*) AS n FROM loop_rules WHERE owner=?', owner),
          active_rules: one("SELECT COUNT(*) AS n FROM loop_rules WHERE owner=? AND governance_status='active'", owner),
          instances: one('SELECT COUNT(*) AS n FROM loop_ontology_instances WHERE owner=?', owner),
          proposals: one("SELECT COUNT(*) AS n FROM loop_ontology_proposals WHERE status='candidate'"),
          runs: db.prepare('SELECT request_json FROM loop_runs').all().filter((r) => runOwner(r) === owner).length,
          skills: one('SELECT COUNT(*) AS n FROM loop_skill_candidates WHERE owner=?', owner),
          conflicts: ruleConflicts(owner).length,
        }
        return sendJson(res, {
          ok: true, db: dbPath, counts,
          by_memory_status: db.prepare('SELECT status,COUNT(*) AS n FROM loop_memories WHERE owner=? GROUP BY status').all(owner),
          by_memory_type: db.prepare('SELECT type,COUNT(*) AS n FROM loop_memories WHERE owner=? GROUP BY type').all(owner),
          model: { endpoint, model, configured: !!(endpoint && model) },
          boundary: { singleUser: true, owner, note: '单用户运行边界；owner 仅用于隔离测试数据，不宣称多租户安全' },
          versions: { schema: 4, prompt: PROMPT_VERSION, ruleSchema: RULE_SCHEMA_VERSION },
          vector: {
            configured: embedEnabled, model: embedModel,
            endpoint: embedEnabled ? embedEndpoint : '',
            note: embedEnabled ? '向量只参与排序；失败自动降级词法' : '向量未配置：仅词法/关联检索',
            counts: embeddingStatus(owner).counts,
          },
          jobs: db.prepare('SELECT status,COUNT(*) AS n FROM loop_jobs WHERE owner=? GROUP BY status').all(owner),
        })
      }

      /* ---- 批次 ---- */
      if (method === 'GET' && parts[0] === 'batches' && parts.length === 1) {
        const owner = queryOwner()
        const limit = Math.min(50, Math.max(1, Number(q('limit')) || 20))
        const sourceId = text(q('source_id'))
        const rows = sourceId
          ? db.prepare('SELECT * FROM loop_batches WHERE source_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(sourceId, limit)
          : db.prepare('SELECT * FROM loop_batches WHERE source_id IN (SELECT id FROM loop_sources WHERE owner=?) ORDER BY created_at DESC, rowid DESC LIMIT ?').all(owner, limit)
        return sendJson(res, { ok: true, items: rows.map(batchJson) })
      }
      if (method === 'GET' && parts[0] === 'batches' && parts[1] && !parts[2]) {
        const row = db.prepare('SELECT * FROM loop_batches WHERE id=?').get(parts[1])
        if (!row) return sendError(res, 404, '批次不存在')
        const b = batchJson(row)
        return sendJson(res, { ok: true, batch: b, chunks: b.detail.chunks || [] })
      }
      if (method === 'POST' && parts[0] === 'batches' && parts[2] === 'retry') {
        return sendJson(res, { ok: true, ...(await retryBatch(parts[1])) })
      }

      if (method === 'GET' && parts[0] === 'jobs' && parts.length === 1) {
        const owner = queryOwner()
        const where = ['owner=?']; const args = [owner]
        for (const key of ['status', 'type', 'source_id']) {
          const v = text(q(key))
          if (v) { where.push(`${key}=?`); args.push(v) }
        }
        const limit = Math.min(200, Math.max(1, Number(q('limit')) || 50))
        const items = db.prepare(`SELECT * FROM loop_jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...args, limit).map(jobJson)
        const counts = db.prepare(`SELECT status,COUNT(*) AS n FROM loop_jobs WHERE owner=? GROUP BY status`).all(owner)
        return sendJson(res, { ok: true, items, counts, worker: { enabled: workerEnabled, id: WORKER_ID, intervalMs: workerIntervalMs } })
      }
      if (method === 'GET' && parts[0] === 'jobs' && parts[1]) {
        const row = db.prepare('SELECT * FROM loop_jobs WHERE id=?').get(parts[1])
        if (!row) return sendError(res, 404, '任务不存在')
        const reqOwner = optionalOwner(url)
        if (reqOwner && row.owner !== reqOwner) return sendError(res, 403, '无权访问该任务')
        const batches = row.source_id ? db.prepare('SELECT * FROM loop_batches WHERE source_id=? ORDER BY created_at DESC LIMIT 5').all(row.source_id).map(batchJson) : []
        return sendJson(res, { ok: true, job: jobJson(row), batches })
      }
      if (method === 'POST' && parts[0] === 'jobs' && parts[2] === 'retry') {
        const body = await readBody(req)
        const row = db.prepare('SELECT * FROM loop_jobs WHERE id=?').get(parts[1])
        if (!row) return sendError(res, 404, '任务不存在')
        const reqOwner = body.owner ? ownerOf(body.owner) : null
        if (reqOwner && row.owner !== reqOwner) return sendError(res, 403, '无权访问该任务')
        if (!['failed', 'partial', 'cancelled'].includes(row.status)) return sendError(res, 409, `当前状态不可重试：${row.status}`)
        db.prepare(`UPDATE loop_jobs SET status='queued',attempts=0,error='',progress_done=0,progress_total=0,result_json='{}',cancel_requested=0,lease_owner=NULL,lease_until=NULL,finished_at=NULL,updated_at=? WHERE id=?`).run(now(), row.id)
        if (row.type === 'extract' && row.source_id) db.prepare('UPDATE loop_sources SET extraction_status=? WHERE id=?').run('queued', row.source_id)
        audit('job.retry.manual', 'job', row.id, { type: row.type })
        scheduleWorker(0)
        return sendJson(res, { ok: true, job: jobJson(db.prepare('SELECT * FROM loop_jobs WHERE id=?').get(row.id)) })
      }
      if (method === 'POST' && parts[0] === 'jobs' && parts[2] === 'cancel') {
        const body = await readBody(req)
        const row = db.prepare('SELECT * FROM loop_jobs WHERE id=?').get(parts[1])
        if (!row) return sendError(res, 404, '任务不存在')
        const reqOwner = body.owner ? ownerOf(body.owner) : null
        if (reqOwner && row.owner !== reqOwner) return sendError(res, 403, '无权访问该任务')
        if (row.status === 'queued') {
          db.prepare(`UPDATE loop_jobs SET status='cancelled',cancel_requested=1,finished_at=?,updated_at=? WHERE id=?`).run(now(), now(), row.id)
        } else if (row.status === 'running') {
          db.prepare(`UPDATE loop_jobs SET cancel_requested=1,updated_at=? WHERE id=?`).run(now(), row.id)
        } else return sendError(res, 409, `当前状态不可取消：${row.status}`)
        audit('job.cancel', 'job', row.id, { status: row.status })
        return sendJson(res, { ok: true, job: jobJson(db.prepare('SELECT * FROM loop_jobs WHERE id=?').get(row.id)) })
      }

      /* ---- 预览/导入 ---- */
      if (method === 'POST' && parts[0] === 'preview') {
        const body = await readBody(req)
        const parsed = parseConversation(body.text, body.format)
        if (body.filename) {
          const v = validateImportFile({ filename: body.filename, text: parsed.raw, sizeBytes: body.sizeBytes, mimeType: body.mimeType })
          if (!v.ok) return sendError(res, 400, v.errors.join('；'), { errors: v.errors })
          parsed.warnings = [...new Set([...(parsed.warnings || []), ...v.warnings])]
        }
        return sendJson(res, {
          ok: true, format: parsed.format, warnings: parsed.warnings, hash: parsed.hash,
          encoding: 'utf-8', size: parsed.size,
          messages: parsed.messages.map((m, i) => ({ index: i + 1, role: m.role, content: m.content, originalTime: m.originalTime, warnings: m.warnings || [], attachments: m.attachments || [] })),
        })
      }
      if (method === 'POST' && parts[0] === 'import' && parts[2] === 'extract') {
        const body = await readBody(req)
        const source = getSource(parts[1])
        if (!source) return sendError(res, 404, '导入记录不存在')
        if (source.archived_at) return sendError(res, 409, '来源已归档，不能继续拆解', { code: 'ARCHIVED' })
        const enq = enqueueExtractJob(source, { force: !!body.force, owner: source.owner })
        return sendJson(res, { ok: true, job: enq.job, job_id: enq.job.id, status: 'queued', duplicate_job: enq.duplicate, batch_id: null, source_id: source.id })
      }
      if (method === 'POST' && parts[0] === 'import' && parts.length === 1) {
        const body = await readBody(req)
        const parsed = parseConversation(body.text, body.format)
        const created = tx(() => createSource(body, parsed))
        let job = null
        if (!created.duplicate && body.autoExtract && !body.ownerOnly && (created.appended ?? 1) > 0) {
          const enq = enqueueExtractJob(getSource(created.source.id), { owner: body.owner })
          job = enq.job
        }
        return sendJson(res, {
          ok: true, duplicate: created.duplicate, appended: created.appended ?? 0,
          source: sourceJson(getSource(created.source.id)), warnings: created.warnings || parsed.warnings,
          attachment_count: created.attachment_count || 0, batch_id: created.batch_id,
          job, job_id: job?.id || null, status: job ? 'queued' : 'saved', queued: !!job,
          extracted: null,
          preview: parsed.messages.map((m) => ({ role: m.role, content: m.content, originalTime: m.originalTime })),
        })
      }
      if (method === 'GET' && parts[0] === 'imports' && parts.length === 1) return sendJson(res, { ok: true, items: listImports(url) })
      if (method === 'GET' && parts[0] === 'imports' && parts[1]) {
        const detail = importDetail(parts[1], queryOwner())
        if (!detail) return sendError(res, 404, '导入来源不存在')
        return sendJson(res, { ok: true, ...detail })
      }
      if (method === 'POST' && parts[0] === 'imports' && parts[2] === 'archive') {
        const source = db.prepare('SELECT * FROM loop_sources WHERE id=?').get(parts[1])
        if (!source) return sendError(res, 404, '导入来源不存在')
        const reqOwner = optionalOwner(url)
        const out = archiveSource(source, reqOwner || source.owner)
        if (!out) return sendError(res, 403, '无权访问该来源')
        return sendJson(res, { ok: true, archived: out, note: '失去唯一证据的派生记忆与规则已退出当前调用；原文保留可审计' })
      }

      /* ---- 记忆 ---- */
      if (method === 'GET' && parts[0] === 'memories' && parts.length === 1) return sendJson(res, { ok: true, items: listMemories(url) })
      if (method === 'GET' && parts[0] === 'memories' && parts[2] === 'versions') return sendJson(res, { ok: true, items: db.prepare('SELECT version,text,object_value,status,note,created_at FROM loop_memory_versions WHERE memory_id=? ORDER BY version').all(parts[1]) })
      if (method === 'GET' && parts[0] === 'memories' && parts[1]) {
        const reqOwner = optionalOwner(url)
        const detail = reqOwner ? memoryDetail(parts[1], reqOwner) : (() => {
          const row = db.prepare('SELECT * FROM loop_memories WHERE id=?').get(parts[1])
          return row ? memoryDetail(parts[1], row.owner) : null
        })()
        if (!detail) return sendError(res, 404, '记忆不存在')
        return sendJson(res, { ok: true, ...detail })
      }
      if (method === 'PATCH' && parts[0] === 'memories' && parts[1]) {
        const body = await readBody(req)
        const reqOwner = body.owner ? ownerOf(body.owner) : null
        const row = reqOwner ? db.prepare('SELECT * FROM loop_memories WHERE id=? AND owner=?').get(parts[1], reqOwner) : db.prepare('SELECT * FROM loop_memories WHERE id=?').get(parts[1])
        if (!row || (reqOwner && row.owner !== reqOwner)) return sendError(res, 404, '记忆不存在')
        snapshotMemoryRow(row, text(body.note) || '人工编辑前快照')
        const next = {
          text: text(body.text) || row.text,
          type: TYPES.includes(body.type) ? body.type : row.type,
          subject: body.subject !== undefined ? text(body.subject) || null : row.subject,
          predicate: body.predicate !== undefined ? text(body.predicate) || null : row.predicate,
          object_value: body.object_value !== undefined ? text(body.object_value) || null : row.object_value,
          scope_type: SCOPES.includes(body.scope_type) ? body.scope_type : row.scope_type,
          scope_id: body.scope_id !== undefined ? text(body.scope_id) || null : row.scope_id,
        }
        const key = sha([next.type, next.subject, next.predicate, next.object_value, next.scope_type, next.scope_id, next.text].join('|'))
        db.prepare(`UPDATE loop_memories SET type=?,text=?,subject=?,predicate=?,object_value=?,normalized_key=?,scope_type=?,scope_id=?,confirmation='confirmed',status='confirmed',protected=1,version=version+1,updated_at=? WHERE id=?`)
          .run(next.type, next.text, next.subject, next.predicate, next.object_value, key, next.scope_type, next.scope_id, now(), row.id)
        const updated = db.prepare('SELECT * FROM loop_memories WHERE id=?').get(row.id)
        snapshotMemoryRow(updated, text(body.note) || '人工编辑')
        enqueueEmbedJob([updated.id], updated.owner)
        audit('memory.edit', 'memory', row.id, { version: updated.version })
        return sendJson(res, { ok: true, memory: memoryJson(updated) })
      }
      if (method === 'POST' && parts[0] === 'memories' && parts[2] === 'correct') {
        const body = await readBody(req); const id = parts[1]
        const reqOwner = body.owner ? ownerOf(body.owner) : null
        const old = reqOwner ? db.prepare('SELECT * FROM loop_memories WHERE id=? AND owner=?').get(id, reqOwner) : db.prepare('SELECT * FROM loop_memories WHERE id=?').get(id)
        if (!old) return sendError(res, 404, '记忆不存在')
        const action = body.action || 'confirm'
        if (action === 'confirm') {
          snapshotMemoryRow(old, '确认前快照')
          db.prepare("UPDATE loop_memories SET confirmation='confirmed', status='confirmed', protected=1, updated_at=? WHERE id=?").run(now(), id)
          audit('memory.confirm', 'memory', id, {})
          enqueueEmbedJob([id], old.owner)
          return sendJson(res, { ok: true, memory: memoryJson(db.prepare('SELECT * FROM loop_memories WHERE id=?').get(id)) })
        }
        if (action === 'archive') {
          snapshotMemoryRow(old, '废弃前快照')
          db.prepare("UPDATE loop_memories SET status='archived', updated_at=? WHERE id=?").run(now(), id)
          audit('memory.archive', 'memory', id, {})
          return sendJson(res, { ok: true })
        }
        if (action === 'supersede') {
          const textNew = text(body.text)
          if (!textNew) return sendError(res, 400, '纠正内容不能为空')
          const nid = uid('mem'); const upd = now()
          snapshotMemoryRow(old, '纠正前快照')
          const evidence = db.prepare('SELECT * FROM loop_memory_evidence WHERE memory_id=?').all(id)
          db.prepare(`INSERT INTO loop_memories(id,source_id,type,text,subject,predicate,object_value,normalized_key,scope_type,scope_id,owner,project,task,source_category,confirmation,certainty,status,recorded_at,version,supersedes_id,confidence,sensitive,metadata_json,created_at,updated_at,protected,parent_memory_id)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            nid, old.source_id, old.type, textNew, old.subject, old.predicate, textNew,
            sha([old.type, old.subject, old.predicate, textNew, old.scope_type, old.scope_id].join('|')),
            old.scope_type, old.scope_id, old.owner, old.project, old.task, 'user_confirmation', 'confirmed', 0.95, 'confirmed',
            upd, (old.version || 1) + 1, old.id, 0.95, old.sensitive, JSON.stringify({ correction: true }), upd, upd, 1, old.id)
          for (const e of evidence) db.prepare('INSERT OR IGNORE INTO loop_memory_evidence(memory_id,message_id,quote) VALUES(?,?,?)').run(nid, e.message_id, e.quote)
          db.prepare("UPDATE loop_memories SET status='superseded', protected=1, updated_at=? WHERE id=?").run(upd, id)
          enqueueEmbedJob([nid], old.owner)
          audit('memory.supersede', 'memory', id, { new_id: nid })
          return sendJson(res, { ok: true, memory: memoryJson(db.prepare('SELECT * FROM loop_memories WHERE id=?').get(nid)) })
        }
        return sendError(res, 400, '未知纠正动作')
      }
      if (method === 'POST' && parts[0] === 'memories' && parts[2] === 'merge') {
        const body = await readBody(req)
        const reqOwner = body.owner ? ownerOf(body.owner) : null
        const owner = reqOwner || db.prepare('SELECT owner FROM loop_memories WHERE id=?').get(parts[1])?.owner || OWNER_DEFAULT
        const ids = [...new Set([parts[1], ...(Array.isArray(body.ids) ? body.ids : [])])]
        if (ids.length < 2) return sendError(res, 400, '合并至少需要两条记忆')
        const rows = ids.map((id) => db.prepare('SELECT * FROM loop_memories WHERE id=? AND owner=?').get(id, owner)).filter(Boolean)
        if (rows.length !== ids.length) return sendError(res, 404, '存在不可访问的记忆')
        const base = rows[0]
        const mergedText = text(body.text) || [...new Set(rows.map((r) => r.text))].join('；')
        const nid = uid('mem'); const upd = now()
        for (const r of rows) snapshotMemoryRow(r, '合并前快照')
        db.prepare(`INSERT INTO loop_memories(id,type,text,subject,predicate,object_value,normalized_key,scope_type,scope_id,owner,project,task,source_category,confirmation,certainty,status,recorded_at,version,confidence,sensitive,metadata_json,created_at,updated_at,protected)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          nid, base.type, mergedText, base.subject, base.predicate, base.object_value,
          sha([base.type, base.subject, base.predicate, mergedText, base.scope_type, base.scope_id].join('|')),
          base.scope_type, base.scope_id, base.owner, base.project, base.task, 'user_confirmation', 'confirmed', 0.95, 'confirmed',
          upd, Math.max(...rows.map((r) => r.version || 1)) + 1, 0.95, base.sensitive, JSON.stringify({ merged_from: ids }), upd, upd, 1)
        const seen = new Set()
        for (const r of rows) for (const e of db.prepare('SELECT message_id,quote FROM loop_memory_evidence WHERE memory_id=?').all(r.id)) {
          if (seen.has(e.message_id)) continue; seen.add(e.message_id)
          db.prepare('INSERT OR IGNORE INTO loop_memory_evidence(memory_id,message_id,quote) VALUES(?,?,?)').run(nid, e.message_id, e.quote)
        }
        for (const r of rows) db.prepare("UPDATE loop_memories SET status='superseded', updated_at=? WHERE id=?").run(upd, r.id)
        enqueueEmbedJob([nid], base.owner)
        audit('memory.merge', 'memory', nid, { merged_from: ids })
        return sendJson(res, { ok: true, memory: memoryJson(db.prepare('SELECT * FROM loop_memories WHERE id=?').get(nid)), merged_ids: ids })
      }

      /* ---- 本体 ---- */
      if (method === 'GET' && parts[0] === 'ontology' && parts.length === 1) {
        const cur = currentOntologyVersion()
        return sendJson(res, {
          ok: true, ...ontologySnapshot(queryOwner()),
          current_version: cur ? { id: cur.id, version: cur.version, action: cur.action, created_at: cur.created_at } : null,
          versions_count: db.prepare('SELECT COUNT(*) AS n FROM loop_ontology_versions').get().n,
        })
      }
      if (method === 'GET' && parts[0] === 'ontology' && parts[1] === 'versions' && parts.length === 2) {
        const items = ontologyVersionRows().map((v) => {
          const diff = json(v.diff_json, {})
          return {
            id: v.id, version: v.version, action: v.action, actor: v.actor, note: v.note, created_at: v.created_at,
            summary: {
              added: { types: diff.added?.types?.length || 0, props: diff.added?.props?.length || 0, relations: diff.added?.relations?.length || 0, states: diff.added?.states?.length || 0 },
              removed: { types: diff.removed?.types?.length || 0, props: diff.removed?.props?.length || 0, relations: diff.removed?.relations?.length || 0, states: diff.removed?.states?.length || 0 },
              changed: { types: diff.changed?.types?.length || 0, props: diff.changed?.props?.length || 0, relations: diff.changed?.relations?.length || 0, states: diff.changed?.states?.length || 0 },
            },
            current: currentOntologyVersion()?.id === v.id,
          }
        })
        return sendJson(res, { ok: true, items, current_version: currentOntologyVersion()?.version || 0 })
      }
      if (method === 'GET' && parts[0] === 'ontology' && parts[1] === 'versions' && parts[3] === 'diff') {
        const row = db.prepare('SELECT * FROM loop_ontology_versions WHERE id=?').get(parts[2])
        if (!row) return sendError(res, 404, '版本不存在')
        const log = db.prepare('SELECT * FROM loop_ontology_change_log WHERE version_id=?').get(row.id)
        return sendJson(res, {
          ok: true, version: { id: row.id, version: row.version, action: row.action, actor: row.actor, note: row.note, created_at: row.created_at },
          diff: json(row.diff_json, {}), snapshot: json(row.snapshot_json, {}),
          change_log: log ? { ...log, change_set: json(log.change_set_json, {}), affected_types: json(log.affected_types_json, []), affected_instances: json(log.affected_instances_json, []), affected_memories: json(log.affected_memories_json, []), affected_rules: json(log.affected_rules_json, []) } : null,
        })
      }
      if (method === 'POST' && parts[0] === 'ontology' && parts[1] === 'versions' && parts[3] === 'rollback') {
        const body = await readBody(req)
        const out = rollbackOntologyVersion(parts[2], { note: text(body.note), confirmImpact: body.confirm_impact === true || body.confirm === true, owner: ownerOf(body.owner) })
        if (out.error) return sendError(res, out.status || 409, out.message || out.error, out)
        return sendJson(res, { ok: true, ...out })
      }
      if (method === 'GET' && parts[0] === 'ontology' && parts[1] === 'instances' && parts[2] && !parts[3]) {
        const inst = instanceDetail(parts[2], queryOwner())
        if (!inst) return sendError(res, 404, '本体实例不存在')
        return sendJson(res, { ok: true, instance: inst })
      }
      if (method === 'POST' && parts[0] === 'ontology' && parts[1] === 'instances' && parts[3] === 'props') {
        const inst = db.prepare('SELECT * FROM loop_ontology_instances WHERE id=? AND owner=?').get(parts[2], ownerOf(q('owner')))
        if (!inst) return sendError(res, 404, '本体实例不存在')
        const out = setInstanceProp(inst, await readBody(req))
        return out.ok ? sendJson(res, { ok: true, ...out }) : sendError(res, out.status || 409, out.message, out)
      }
      if (method === 'POST' && parts[0] === 'ontology' && parts[1] === 'instances' && parts[3] === 'relations') {
        const inst = db.prepare('SELECT * FROM loop_ontology_instances WHERE id=? AND owner=?').get(parts[2], ownerOf(q('owner')))
        if (!inst) return sendError(res, 404, '本体实例不存在')
        const out = setInstanceRelation(inst, await readBody(req), ownerOf(q('owner')))
        return out.ok ? sendJson(res, { ok: true, ...out }) : sendError(res, out.status || 409, out.message, out)
      }
      if (method === 'POST' && parts[0] === 'ontology' && parts[1] === 'instances' && parts[3] === 'state') {
        const inst = db.prepare('SELECT * FROM loop_ontology_instances WHERE id=? AND owner=?').get(parts[2], ownerOf(q('owner')))
        if (!inst) return sendError(res, 404, '本体实例不存在')
        const out = setInstanceState(inst, await readBody(req))
        return out.ok ? sendJson(res, { ok: true, ...out }) : sendError(res, out.status || 409, out.message, out)
      }
      if (method === 'POST' && parts[0] === 'ontology' && parts[1] === 'proposals' && parts[3] === 'approve') {
        const body = await readBody(req)
        const p = db.prepare('SELECT * FROM loop_ontology_proposals WHERE id=?').get(parts[2])
        if (!p) return sendError(res, 404, '候选不存在')
        const before = ontologyDefsSnapshot()
        try {
          const result = tx(() => {
            const applied = applyOntologyProposal(p.kind, json(p.payload_json, {}))
            if (applied.error) throw Object.assign(new Error(applied.error), { code: 'INVALID_PROPOSAL' })
            const after = ontologyDefsSnapshot()
            const errors = validateOntologyStructure(after)
            if (errors.length) throw Object.assign(new Error(`结构校验失败：${errors.join('；')}`), { code: 'INVALID_PROPOSAL', errors })
            const version = saveOntologyVersion({
              action: 'publish', before, after, note: `发布结构候选 ${p.id}`,
              operator: ownerOf(body.owner), changeSet: { proposal_id: p.id, kind: p.kind, payload: json(p.payload_json, {}) },
            })
            db.prepare("UPDATE loop_ontology_proposals SET status='approved', updated_at=? WHERE id=?").run(now(), p.id)
            return { applied, version }
          })
          audit('ontology.proposal.approve', 'proposal', p.id, { kind: p.kind, applied: result.applied, version: result.version.version })
          return sendJson(res, { ok: true, ...result })
        } catch (e) {
          return sendError(res, 400, e.message, { errors: e.errors || [], code: e.code || 'INVALID_PROPOSAL' })
        }
      }
      if (method === 'POST' && parts[0] === 'ontology' && parts[1] === 'proposals' && parts[3] === 'reject') {
        const p = db.prepare('SELECT * FROM loop_ontology_proposals WHERE id=?').get(parts[2])
        if (!p) return sendError(res, 404, '候选不存在')
        db.prepare("UPDATE loop_ontology_proposals SET status='rejected', updated_at=? WHERE id=?").run(now(), p.id)
        audit('ontology.proposal.reject', 'proposal', p.id, { kind: p.kind })
        return sendJson(res, { ok: true })
      }

      /* ---- 规则 ---- */
      if (method === 'GET' && parts[0] === 'rules' && parts[1] === 'conflicts') {
        const conflicts = ruleConflicts(queryOwner())
        return sendJson(res, {
          ok: true,
          items: conflicts.map((c) => ({
            key: c.key, a: c.a, b: c.b, reason: c.reason, resolution: c.resolution,
            auto_resolution: c.auto_resolution, adjudicated: c.adjudicated, unresolved: c.unresolved,
            manual: c.manual, precedence: c.precedence,
          })),
          unresolved: conflicts.filter((c) => !c.adjudicated).length,
          adjudicated: conflicts.filter((c) => c.adjudicated).length,
        })
      }
      if (method === 'POST' && parts[0] === 'rules' && parts[1] === 'conflicts' && parts[3] === 'resolve') {
        const body = await readBody(req)
        const out = resolveRuleConflict(parts[2], body)
        if (!out.ok) return sendError(res, out.status || 400, out.message || out.error, out)
        return sendJson(res, out)
      }
      if (method === 'GET' && parts[0] === 'rules' && parts.length === 1) return sendJson(res, { ok: true, items: listRules(url) })
      if (method === 'GET' && parts[0] === 'rules' && parts[2] === 'versions') {
        const items = db.prepare('SELECT version,payload_json,note,created_at FROM loop_rule_versions WHERE rule_id=? ORDER BY created_at').all(parts[1]).map((v) => ({ ...v, payload: json(v.payload_json, {}) }))
        return sendJson(res, { ok: true, items })
      }
      if (method === 'GET' && parts[0] === 'rules' && parts[1]) {
        const reqOwner = optionalOwner(url)
        const detail = reqOwner ? ruleDetail(parts[1], reqOwner) : (() => {
          const row = db.prepare('SELECT * FROM loop_rules WHERE id=?').get(parts[1])
          return row ? ruleDetail(parts[1], row.owner) : null
        })()
        if (!detail) return sendError(res, 404, '规则不存在')
        return sendJson(res, { ok: true, ...detail })
      }
      if (method === 'POST' && parts[0] === 'rules' && parts[2] === 'approve') {
        const body = await readBody(req)
        const reqOwner = body.owner ? ownerOf(body.owner) : null
        const r = reqOwner ? db.prepare('SELECT * FROM loop_rules WHERE id=? AND owner=?').get(parts[1], reqOwner) : db.prepare('SELECT * FROM loop_rules WHERE id=?').get(parts[1])
        if (!r) return sendError(res, 404, '规则不存在')
        const conditions = json(r.conditions_json, {})
        const errors = conditionPathErrors(conditions)
        const actions = json(r.actions_json, [])
        if (errors.length) return sendError(res, 400, `规则条件不合法：${errors.join('；')}`, { errors })
        if (!actions.length) return sendError(res, 400, '规则没有可执行动作')
        tx(() => {
          db.prepare("UPDATE loop_rules SET governance_status='active', confirmation='confirmed', structure_status='structured', structure_errors_json='[]', version=version+1, updated_at=? WHERE id=?").run(now(), r.id)
          if (r.supersedes_id) db.prepare("UPDATE loop_rules SET governance_status='superseded',updated_at=? WHERE id=? AND owner=?").run(now(), r.supersedes_id, r.owner)
        })
        const updated = db.prepare('SELECT * FROM loop_rules WHERE id=?').get(r.id)
        saveRuleVersion(r.id, ruleJson(updated), '人工确认生效')
        audit('rule.approve', 'rule', r.id, {})
        return sendJson(res, { ok: true, rule: ruleJson(updated) })
      }
      if (method === 'POST' && parts[0] === 'rules' && ['pause', 'resume', 'archive'].includes(parts[2])) {
        const body = await readBody(req)
        const reqOwner = body.owner ? ownerOf(body.owner) : null
        const r = reqOwner ? db.prepare('SELECT * FROM loop_rules WHERE id=? AND owner=?').get(parts[1], reqOwner) : db.prepare('SELECT * FROM loop_rules WHERE id=?').get(parts[1])
        if (!r) return sendError(res, 404, '规则不存在')
        const target = parts[2] === 'pause' ? 'paused' : parts[2] === 'resume' ? 'active' : 'superseded'
        if (parts[2] === 'resume' && r.structure_status !== 'structured') return sendError(res, 400, '规则尚未结构化，不能恢复生效')
        db.prepare('UPDATE loop_rules SET governance_status=?, confirmation=?, updated_at=? WHERE id=?').run(target, target === 'active' ? 'confirmed' : r.confirmation, now(), r.id)
        audit(`rule.${parts[2]}`, 'rule', r.id, {})
        return sendJson(res, { ok: true, rule: ruleJson(db.prepare('SELECT * FROM loop_rules WHERE id=?').get(r.id)) })
      }
      if (method === 'POST' && parts[0] === 'rules' && parts[2] === 'simulate') {
        const body = await readBody(req)
        const reqOwner = body.owner ? ownerOf(body.owner) : null
        const r = reqOwner ? db.prepare('SELECT * FROM loop_rules WHERE id=? AND owner=?').get(parts[1], reqOwner) : db.prepare('SELECT * FROM loop_rules WHERE id=?').get(parts[1])
        if (!r) return sendError(res, 404, '规则不存在')
        const out = simulateRule(ruleJson(r), body.context || {})
        db.prepare('INSERT INTO loop_rule_evals(id,rule_id,context_json,result,reason,created_at) VALUES(?,?,?,?,?,?)').run(uid('eval'), r.id, JSON.stringify(body.context || {}), out.result, out.reason, now())
        return sendJson(res, { ok: true, ...out, simulatedOnly: true, note: '模拟评估只读，不触发任何业务动作' })
      }
      if (method === 'PATCH' && parts[0] === 'rules' && parts[1]) {
        const body = await readBody(req)
        const reqOwner = body.owner ? ownerOf(body.owner) : null
        const r = reqOwner ? db.prepare('SELECT * FROM loop_rules WHERE id=? AND owner=?').get(parts[1], reqOwner) : db.prepare('SELECT * FROM loop_rules WHERE id=?').get(parts[1])
        if (!r) return sendError(res, 404, '规则不存在')
        const prev = fieldsFromRule(r)
        const fields = { ...prev }
        for (const k of ['name', 'description', 'category', 'scope_type', 'scope_id', 'strength', 'acceptance', 'valid_from', 'valid_to', 'trigger_event', 'object_type', 'object_id']) {
          if (body[k] !== undefined) fields[k] = body[k]
        }
        if (body.conditions !== undefined) fields.conditions = normalizeConditionForOntology(body.conditions)
        if (body.actions !== undefined) fields.actions = body.actions
        if (body.exceptions !== undefined) fields.exceptions = body.exceptions
        if (body.structure_status !== undefined) fields.structure_status = body.structure_status
        const errors = fields.conditions && Object.keys(fields.conditions).length ? conditionPathErrors(fields.conditions) : []
        fields.structure_errors = errors
        fields.structure_status = errors.length ? 'invalid_condition' : (Object.keys(fields.conditions || {}).length ? 'structured' : 'unstructured')
        fields.confirmation = 'human_edited'
        fields.version = (r.version || 1) + 1
        fields.source_category = 'user_statement'
        fields.owner = r.owner
        const updated = updateRuleRow(r.id, fields, text(body.note) || '人工编辑规则')
        return sendJson(res, { ok: true, rule: ruleJson(updated), errors })
      }
      if (method === 'POST' && parts[0] === 'rules' && parts[2] === 'supersede') {
        const body = await readBody(req)
        const reqOwner = body.owner ? ownerOf(body.owner) : null
        const old = reqOwner ? db.prepare('SELECT * FROM loop_rules WHERE id=? AND owner=?').get(parts[1], reqOwner) : db.prepare('SELECT * FROM loop_rules WHERE id=?').get(parts[1])
        if (!old) return sendError(res, 404, '规则不存在')
        const prev = fieldsFromRule(old)
        const fields = { ...prev }
        for (const k of ['name', 'description', 'category', 'scope_type', 'scope_id', 'strength', 'acceptance', 'valid_from', 'valid_to']) if (body[k] !== undefined) fields[k] = body[k]
        if (body.conditions !== undefined) fields.conditions = normalizeConditionForOntology(body.conditions)
        if (body.actions !== undefined) fields.actions = body.actions
        if (body.exceptions !== undefined) fields.exceptions = body.exceptions
        const errors = fields.conditions && Object.keys(fields.conditions).length ? conditionPathErrors(fields.conditions) : []
        fields.structure_errors = errors
        fields.structure_status = errors.length ? 'invalid_condition' : 'structured'
        fields.confirmation = 'candidate'
        fields.governance_status = body.activate === true ? 'active' : 'candidate'
        fields.supersedes_id = old.id
        fields.source_category = 'user_confirmation'
        fields.version = 1
        if (body.activate === true && errors.length) return sendError(res, 409, '规则结构无效，不能生效', { errors })
        const row = tx(() => {
          const next = persistRule(fields)
          if (fields.governance_status === 'active') db.prepare("UPDATE loop_rules SET governance_status='superseded', updated_at=? WHERE id=?").run(now(), old.id)
          return next
        })
        audit('rule.supersede', 'rule', old.id, { new_id: row.id, activated: body.activate === true })
        return sendJson(res, { ok: true, rule: ruleJson(row) })
      }

      /* ---- Skill ---- */
      if (method === 'GET' && parts[0] === 'skills') return sendJson(res, { ok: true, items: listSkills(url) })
      if (method === 'POST' && parts[0] === 'skills' && parts[1] === 'derive') {
        const body = await readBody(req)
        const ids = deriveSkills(ownerOf(body.owner), text(body.project), body.min_memories)
        return sendJson(res, { ok: true, derived: ids.length, items: db.prepare(`SELECT * FROM loop_skill_candidates WHERE id IN (${ids.map(() => '?').join(',') || "''"})`).all(...ids).map(skillJson) })
      }
      if (method === 'PATCH' && parts[0] === 'skills' && parts[1]) {
        const body = await readBody(req)
        const reqOwner = body.owner ? ownerOf(body.owner) : null
        const s = reqOwner ? db.prepare('SELECT * FROM loop_skill_candidates WHERE id=? AND owner=?').get(parts[1], reqOwner) : db.prepare('SELECT * FROM loop_skill_candidates WHERE id=?').get(parts[1])
        if (!s) return sendError(res, 404, 'Skill 候选不存在')
        const cur = skillJson(s)
        const next = { ...cur }
        for (const k of ['name', 'scenario', 'acceptance', 'output_format']) if (body[k] !== undefined) next[k] = text(body[k])
        for (const k of ['inputs', 'preconditions', 'steps', 'exceptions', 'boundaries']) if (Array.isArray(body[k])) next[k] = body[k]
        db.prepare(`UPDATE loop_skill_candidates SET name=?,scenario=?,inputs_json=?,preconditions_json=?,steps_json=?,exceptions_json=?,boundaries_json=?,acceptance=?,output_format=?,status='edited',version=version+1,updated_at=? WHERE id=?`).run(
          next.name, next.scenario, JSON.stringify(next.inputs), JSON.stringify(next.preconditions), JSON.stringify(next.steps), JSON.stringify(next.exceptions), JSON.stringify(next.boundaries), next.acceptance, next.output_format, now(), s.id)
        audit('skill.edit', 'skill', s.id, { version: (s.version || 1) + 1 })
        return sendJson(res, { ok: true, skill: skillJson(db.prepare('SELECT * FROM loop_skill_candidates WHERE id=?').get(s.id)) })
      }
      if (method === 'POST' && parts[0] === 'skills' && parts[2] === 'export') {
        const body = await readBody(req)
        const reqOwner = body.owner ? ownerOf(body.owner) : null
        const s = reqOwner ? db.prepare('SELECT * FROM loop_skill_candidates WHERE id=? AND owner=?').get(parts[1], reqOwner) : db.prepare('SELECT * FROM loop_skill_candidates WHERE id=?').get(parts[1])
        if (!s) return sendError(res, 404, 'Skill 候选不存在')
        const skill = skillJson(s)
        db.prepare("UPDATE loop_skill_candidates SET status='exported', updated_at=? WHERE id=?").run(now(), s.id)
        audit('skill.export', 'skill', s.id, {})
        return sendJson(res, { ok: true, markdown: skillMarkdown(skill), filename: `${skill.name.replace(/[\\/:*?"<>|]/g, '_')}.md` })
      }
      if (method === 'POST' && parts[0] === 'skills' && parts[2] === 'reject') {
        const body = await readBody(req)
        db.prepare("UPDATE loop_skill_candidates SET status='rejected', updated_at=? WHERE id=? AND owner=?").run(now(), parts[1], ownerOf(body.owner))
        audit('skill.reject', 'skill', parts[1], {})
        return sendJson(res, { ok: true })
      }

      /* ---- 上下文/反馈/运行/审计 ---- */
      if (method === 'POST' && parts[0] === 'context') {
        const body = await readBody(req)
        const result = await buildContext(body)
        if (!result.ok) return sendJson(res, result, 409)
        return sendJson(res, result)
      }
      if (method === 'GET' && parts[0] === 'feedback') {
        const owner = queryOwner()
        const items = db.prepare('SELECT * FROM loop_feedback ORDER BY created_at DESC LIMIT 100').all()
          .filter((f) => feedbackOwner(f) === owner)
          .map((f) => ({ ...f, correction: json(f.correction_json, {}) }))
        return sendJson(res, { ok: true, items })
      }
      if (method === 'POST' && parts[0] === 'feedback') {
        const body = await readBody(req)
        return sendJson(res, submitFeedback(body))
      }
      if (method === 'GET' && parts[0] === 'runs') {
        const owner = queryOwner()
        const items = db.prepare('SELECT * FROM loop_runs ORDER BY created_at DESC LIMIT 100').all()
          .filter((r) => runOwner(r) === owner).slice(0, 50)
          .map((r) => ({ ...r, request: json(r.request_json, {}), context: json(r.context_json, {}) }))
        return sendJson(res, { ok: true, items })
      }
      if (method === 'GET' && parts[0] === 'audit') {
        return sendJson(res, { ok: true, items: db.prepare('SELECT * FROM loop_audit ORDER BY created_at DESC LIMIT 200').all().map((a) => ({ ...a, detail: json(a.detail_json, {}) })) })
      }
      if (method === 'POST' && parts[0] === 'actions' && parts[1] === 'check') {
        const body = await readBody(req)
        const out = await evaluateActions(body)
        if (!out.ok) return sendJson(res, out, out.error === 'hard_constraints_exceed_budget' ? 409 : 400)
        return sendJson(res, out)
      }
      if (method === 'GET' && parts[0] === 'actions') {
        const owner = queryOwner()
        const limit = Math.min(100, Math.max(1, Number(q('limit')) || 20))
        const items = db.prepare('SELECT * FROM loop_action_checks WHERE owner=? ORDER BY created_at DESC LIMIT ?').all(owner, limit)
          .map((r) => ({
            ...r, rule_ids: json(r.rule_ids_json, []), actions: json(r.actions_json, []), detail: json(r.detail_json, {}),
          }))
        return sendJson(res, { ok: true, items, boundary: { singleUser: true, executed: false, note: '动作校验只记录，不执行外部操作' } })
      }
      if (method === 'GET' && parts[0] === 'embeddings' && parts[1] === 'status') {
        const owner = queryOwner()
        const status = embeddingStatus(owner)
        const probe = embedEnabled ? await probeEmbedding(q('probe') === '1') : { ok: false, error: 'not_configured' }
        return sendJson(res, { ok: true, ...status, available: !!probe.ok, probe })
      }
      if (method === 'POST' && parts[0] === 'embeddings' && parts[1] === 'reindex') {
        const body = await readBody(req)
        const out = reindexEmbeddings(ownerOf(body.owner || queryOwner()))
        if (!out.ok) return sendError(res, 409, out.message || out.error, out)
        audit('embeddings.reindex', 'embedding', out.job?.id || null, { queued: out.queued })
        return sendJson(res, { ok: true, ...out, configured: true, model: embedModel })
      }
      if (method === 'GET' && parts[0] === 'graph') return sendJson(res, { ok: true, ...graphData(queryOwner(), text(q('project')), Math.min(500, Number(q('limit')) || 200)) })
      if (method === 'GET' && parts[0] === 'search') {
        const out = searchLoop(queryOwner(), q('q'), Number(q('limit')) || 12)
        return sendJson(res, { ok: true, ...out })
      }
      return sendError(res, 404, '未知闭环接口')
    } catch (e) {
      logger?.warn?.(`[memory-brain] loop ${url.pathname} failed: ${e?.message || e}`)
      const code = e?.code
      const status = code === 'MODEL_UNAVAILABLE' ? 503 : code === 'FORBIDDEN' ? 403 : code === 'NOT_FOUND' ? 404 : code === 'ARCHIVED' ? 409 : 400
      return sendError(res, status, e?.message || String(e), code ? { code } : {})
    }
  }

  /* ---------------------------------------------------------------- 上下文组装 */

  /* ---------------------------------------------------------------- 检索重排 */

  function tokenizeQuery(q) {
    const s = String(q || '').toLowerCase().trim()
    if (!s) return []
    const tokens = new Set()
    for (const raw of s.split(/[\s,，。.;；:：!?！？、/|()（）\[\]{}"'“”]+/)) {
      const w = raw.trim()
      if (!w) continue
      if (/[\u4e00-\u9fa5]/.test(w)) {
        if (w.length <= 6) tokens.add(w)
        for (let i = 0; i < w.length - 1; i++) tokens.add(w.slice(i, i + 2))
      } else if (w.length >= 2) tokens.add(w)
    }
    return [...tokens].slice(0, 24)
  }

  function scoreMemory(m, tokens, objectIds, vectorScores = null) {
    const text = `${m.text || ''} ${m.subject || ''} ${m.object_value || ''}`.toLowerCase()
    const evidence = (m.evidence || []).map((e) => String(e.quote || '').toLowerCase()).join(' ')
    let score = 0
    const matched = []
    for (const t of tokens) {
      if (!t) continue
      if (text.includes(t)) { score += 2.5; matched.push(t) }
      else if (evidence.includes(t)) { score += 1; matched.push(`证据:${t}`) }
    }
    if (['constraint', 'decision'].includes(m.type)) score += 1.2
    else if (m.type === 'fact') score += 0.8
    score += ({ artifact: 2, task: 1.8, project: 1.5, domain: 1.2, personal: 0.8 }[m.scope_type] || 0)
    if (m.protected) score += 0.4
    if (m.ontology_instance_id && objectIds.has(m.ontology_instance_id)) { score += 3; matched.push('本体关联') }
    const vscore = vectorScores?.get ? vectorScores.get(m.id) : null
    if (vscore != null) { score += Number(vscore) * 3; matched.push(`向量:${Number(vscore).toFixed(2)}`) }
    const age = Date.now() - new Date(m.recorded_at || m.created_at || 0).getTime()
    if (Number.isFinite(age)) score += Math.max(0, 1 - age / (1000 * 60 * 60 * 24 * 30)) * 0.3
    return { score, matched }
  }

  /**
   * 确定性检索：硬约束始终保留；其余按关键词/证据/范围/本体关联/时近重排。
   * 不声称语义向量相似；语义检索仍由现有 xiaojiu_brain 服务负责。
   */
  function retrieveMemories(memories, { query, objectIds, limit = 80, vectorScores = null } = {}) {
    const tokens = tokenizeQuery(query)
    const hard = memories.filter((m) => m.type === 'constraint' && m.status === 'confirmed')
    const hardIds = new Set(hard.map((m) => m.id))
    if (!tokens.length) {
      const selected = [...hard, ...memories.filter((m) => !hardIds.has(m.id)).slice(0, Math.max(0, limit - hard.length))]
      return {
        selected,
        meta: { query: text(query), tokens: [], candidate_count: memories.length, selected_count: selected.length, hard_kept: hard.length, truncated: memories.length > selected.length, expanded: 0, top: [] },
      }
    }
    const scored = memories.map((m) => ({ m, ...scoreMemory(m, tokens, objectIds, vectorScores) }))
    const ranked = scored.sort((a, b) => b.score - a.score)
    const selected = []
    const seen = new Set()
    for (const x of ranked) {
      if (seen.has(x.m.id)) continue
      if (selected.length >= limit && !hardIds.has(x.m.id)) continue
      selected.push(x.m); seen.add(x.m.id)
    }
    for (const m of hard) if (!seen.has(m.id)) { selected.push(m); seen.add(m.id) }
    return {
      selected,
      meta: {
        query: text(query), tokens: tokens.slice(0, 12), candidate_count: memories.length, selected_count: selected.length,
        hard_kept: hard.length, truncated: memories.length > selected.length,
        expanded: ranked.filter((x) => x.matched.includes('本体关联')).length,
        top: ranked.slice(0, 12).map((x) => ({ memory_id: x.m.id, score: Number(x.score.toFixed(2)), matched: x.matched.slice(0, 6), text: (x.m.text || '').slice(0, 80) })),
      },
    }
  }

  /* ---------------------------------------------------------------- 动作权限 */

  function actionTypeOf(a) { return text(a?.type || a?.action || a?.op).toLowerCase() }
  function actionTargetOf(a) { return text(a?.target || a?.object || a?.scope || a?.name) }
  const BLOCK_ACTION = /^(block|deny|forbid|cancel|disable|reject)$/i
  const ALLOW_ACTION = /^(allow|grant|permit|authorize)$/i
  const matchesAction = (action, requested) => {
    if (!requested) return true
    const target = actionTargetOf(action)
    if (target) return [actionTargetOf(requested), actionTypeOf(requested), text(requested.object_id)].includes(target)
    return BLOCK_ACTION.test(actionTypeOf(action)) || ALLOW_ACTION.test(actionTypeOf(action)) || actionTypeOf(action) === actionTypeOf(requested)
  }

  /**
   * 动作权限单独校验：规则生效 ≠ 获准执行。
   * 规则只能是约束/建议；执行类动作必须同时满足「用户本次明确授权」+「适用的 permission 规则」。
   * 本机未连接外部执行器，所以即使 authorized 也只记录 authorized_not_executed。
   */
  async function evaluateActions(body = {}, trusted = {}) {
    const context = await buildContext(body)
    if (!context.ok) return context
    const owner = ownerOf(body.owner)
    const project = text(body.project)
    const task = text(body.task)
    const objectId = text(body.object_id || body.object?.id || body.object?.instance_id)
    const objectName = text(body.object?.name || body.object_name)
    const requested = body.action && typeof body.action === 'object' ? body.action : null
    // Only the host integration may supply current-user authorization out of band.
    const explicit = trusted.authorized === true
    const permissionRules = context.sections.rules.filter((r) => r.category === 'permission')
    const checks = []
    for (const rule of context.sections.unknowns || []) {
      if (!['must', 'must_not'].includes(rule.strength)) continue
      if (!(rule.actions || []).some(action => matchesAction(action, requested))) continue
      checks.push({ rule_id: rule.rule_id, rule_name: rule.name, action: requested, result: 'blocked', authorization: 'unverifiable', reason: `必需约束无法验证：${rule.reason}` })
    }
    for (const rule of context.sections.rules) {
      if (rule.category === 'permission' && rule.strength !== 'must_not' && !(rule.actions || []).some((a) => BLOCK_ACTION.test(actionTypeOf(a)))) continue
      for (const action of Array.isArray(rule.actions) ? rule.actions : []) {
        if (!matchesAction(action, requested)) continue
        const blocking = rule.strength === 'must_not' || BLOCK_ACTION.test(actionTypeOf(action))
        let result; let authorization; let reason; let permissionRuleId = null
        if (blocking) {
          result = 'blocked'; authorization = 'not_applicable'
          reason = `规则「${rule.name}」强度为 ${rule.strength}，该动作被禁止；规则生效不能绕过约束`
        } else {
          const perm = permissionRules.find((p) => p.strength !== 'must_not' && (p.actions || []).some((a) => ALLOW_ACTION.test(actionTypeOf(a)) && (!actionTargetOf(a) || actionTargetOf(a) === actionTargetOf(action))))
          if (!perm) {
            result = 'denied'; authorization = 'no_permission_rule'
            reason = '没有适用的动作权限规则；业务记忆/规则不能覆盖工具或系统授权'
          } else if (!explicit) {
            result = 'pending_authorization'; authorization = 'not_granted'; permissionRuleId = perm.id
            reason = '规则已生效，但未获得本次执行授权；需要用户明确授权，不能把规则生效当作执行许可'
          } else {
            result = 'authorized_not_executed'; authorization = 'explicit'; permissionRuleId = perm.id
            reason = `已获得本次明确授权，且权限规则「${perm.name}」适用；本机未连接外部执行器，未执行外部操作`
          }
        }
        checks.push({ rule_id: rule.id, rule_name: rule.name, category: rule.category, strength: rule.strength, action, result, authorization, reason, permission_rule_id: permissionRuleId })
      }
    }
    if (!checks.length) {
      checks.push({ rule_id: null, rule_name: null, action: requested, result: 'no_applicable_action', authorization: explicit ? 'explicit' : 'not_granted', reason: '当前上下文没有适用的动作规则；没有动作被授权执行' })
    }
    const result = checks.some((c) => c.result === 'blocked') ? 'blocked'
      : checks.some((c) => c.result === 'denied') ? 'denied'
        : checks.some((c) => c.result === 'pending_authorization') ? 'pending_authorization'
          : checks.some((c) => c.result === 'authorized_not_executed') ? 'authorized_not_executed' : 'no_applicable_action'
    const id = uid('act')
    const ruleIds = [...new Set(checks.map((c) => c.rule_id).filter(Boolean))]
    db.prepare(`INSERT INTO loop_action_checks(id,owner,project,task,object_id,object_name,run_id,rule_ids_json,actions_json,result,authorization,reason,detail_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, owner, project || null, task || null, objectId || null, objectName || null, context.run_id || null,
      JSON.stringify(ruleIds), JSON.stringify(checks), result, explicit ? 'explicit' : 'not_granted',
      checks.map((c) => c.reason).join('；').slice(0, 1000), JSON.stringify({ checks, authorization_note: text(body.authorization_note), executed: false }), now())
    audit('action.check', 'action', id, { result, rules: ruleIds.length, explicit, executed: false })
    return {
      ok: true, check_id: id, result, authorization_requested: body.authorized === true || explicit, authorized: result === 'authorized_not_executed', executed: false,
      note: explicit ? '已记录授权结果；即使 authorized 也不执行外部操作（未连接执行器）' : '未授权；只记录校验结果',
      context_run_id: context.run_id, items: checks,
    }
  }

  async function buildContext(body = {}) {
    const owner = ownerOf(body.owner)
    const project = text(body.project)
    const task = text(body.task)
    const taskId = text(body.task_id) || task
    const objectId = text(body.object_id || body.object?.id || body.object?.instance_id)
    const objectName = text(body.object?.name || body.object_name)
    const includeSensitive = body.include_sensitive === true
    const instruction = text(body.instruction)
    const query = text(body.query || body.retrieval_query) || task || instruction
    const nowIso = now()
    const scopeOk = (row) => {
      if (row.owner !== owner) return false
      // A project binding narrows every scope, including personal/artifact names.
      if (row.project && String(row.project) !== project) return false
      if (!row.scope_type) return true
      if (row.scope_type === 'personal' || row.scope_type === 'domain') return true
      if (row.scope_type === 'project') return !!project && String(row.scope_id || '') === project
      if (row.scope_type === 'task') return !!taskId && String(row.scope_id || '') === taskId
      if (row.scope_type === 'artifact') return (!!objectId && (String(row.scope_id || '') === objectId || String(row.object_id || '') === objectId))
        || (!!objectName && String(row.scope_id || '') === objectName)
      return false
    }
    const allMemories = db.prepare(`SELECT * FROM loop_memories WHERE owner=? AND status IN ('confirmed','conflict')
      AND (project IS NULL OR project='' OR project=?) AND (valid_from IS NULL OR valid_from<=?) AND (valid_to IS NULL OR valid_to>?)
      AND COALESCE(json_extract(metadata_json,'$.ontology_orphaned'),0)=0 ORDER BY COALESCE(event_time, recorded_at) DESC`).all(owner, project, nowIso, nowIso)
    const validNow = (m) => (!m.valid_to || m.valid_to > nowIso) && (!m.valid_from || m.valid_from <= nowIso)
    const inScope = allMemories.filter(scopeOk).filter(validNow).map(memoryJson)
    const sensitiveFiltered = inScope.filter((m) => m.sensitive)
    const visibleMemories = includeSensitive ? inScope : inScope.filter((m) => !m.sensitive)
    const objectRows = db.prepare(`SELECT * FROM loop_ontology_instances WHERE owner=? AND status='active'
      AND (project IS NULL OR project='' OR project=?)
      AND (?='' AND ?='' OR id=? OR name=? OR name=?) ORDER BY updated_at DESC LIMIT 100`)
      .all(owner, project, objectId, objectName, objectId, objectId, objectName).map(instanceSnapshot)
    const objIds = new Set(objectRows.map((o) => o.id))
    const vector = await vectorScoresFor(visibleMemories, query)
    const retrieval = retrieveMemories(visibleMemories, { query, objectIds: objIds, limit: Math.min(200, Math.max(1, Number(body.retrieval_limit) || 80)), vectorScores: vector.scores })
    retrieval.meta.vector = vector.meta
    const memories = retrieval.selected
    const confirmed = memories.filter((m) => m.status === 'confirmed')
    const suggestions = db.prepare(`SELECT * FROM loop_memories WHERE owner=? AND status IN ('proposed','needs_confirmation') ORDER BY created_at DESC LIMIT 80`).all(owner)
      .filter(scopeOk).filter(validNow).filter((m) => includeSensitive || !m.sensitive).slice(0, 30).map(memoryJson)
    const allRules = db.prepare(`SELECT * FROM loop_rules WHERE owner=? AND governance_status='active' ORDER BY updated_at DESC`).all(owner)
      .filter((r) => (!r.valid_to || r.valid_to > nowIso) && (!r.valid_from || r.valid_from <= nowIso))
      .filter(scopeOk)
    const ranked = rankRules(allRules.map(ruleJson))
    const ctx = {
      ...body, user: body.user || owner, owner, project, task,
      object: body.object || (objectName ? { name: objectName } : {}),
      state: body.state || {},
    }
    // Bind authoritative properties only for a uniquely identified object.
    if ((objectId || objectName) && objectRows.length === 1) {
      const o = objectRows[0]
      const properties = Object.fromEntries(o.properties.map(p => [p.name, p.value]))
      const current = { ...properties, ...(o.current_state ? { status: o.current_state } : {}) }
      Object.defineProperty(ctx, o.type_id, { value: { ...(body[o.type_id] || {}), ...current, id: o.id, name: o.name }, enumerable: true })
      ctx.object = { ...ctx.object, ...current, id: o.id, name: o.name, type: o.type_id }
      ctx.state = { ...ctx.state, ...current }
    }
    const evaluations = ranked.map((r) => ({ ...simulateRule(r, ctx), rule: r }))
    const allConflicts = ruleConflicts(owner)
    const ruleConflictList = allConflicts.filter((c) => evaluations.some((e) => e.rule.id === c.a_id || e.rule.id === c.b_id))
    // 人工裁决后的执行过滤：未裁决冲突保留双方；裁决过的按结果执行并保留记录。
    const applicable = []
    const excludedByResolution = []
    for (const e of evaluations.filter((x) => x.result === 'applicable')) {
      let excludedBy = null
      const adjudications = []
      for (const c of allConflicts) {
        if (!c.manual) continue
        if (e.rule.id !== c.a_id && e.rule.id !== c.b_id) continue
        const res = c.manual.resolution
        if (res === 'disable_both' || (res === 'prefer_a' && e.rule.id === c.b_id) || (res === 'prefer_b' && e.rule.id === c.a_id)) {
          excludedBy = { conflict_key: c.key, resolution: res, note: c.manual.note }
          break
        }
        adjudications.push({ conflict_key: c.key, resolution: res, note: c.manual.note })
      }
      if (excludedBy) { e.excluded_by_resolution = excludedBy; excludedByResolution.push(e.rule.id) }
      else { if (adjudications.length) e.adjudicated = adjudications; applicable.push(e) }
    }
    const unknownRules = evaluations.filter((e) => e.result === 'unknown')
    const hard = applicable.filter((e) => ['must', 'must_not'].includes(e.rule.strength))
    const memConflicts = memories.filter((m) => m.status === 'conflict' || (m.conflict_group && m.status === 'confirmed'))
    const memGroups = new Map()
    for (const m of memConflicts) { const g = m.conflict_group || m.id; if (!memGroups.has(g)) memGroups.set(g, []); memGroups.get(g).push({ id: m.id, version: m.version, scope_type: m.scope_type, scope_id: m.scope_id, text: m.text, status: m.status, evidence: m.evidence }) }
    const facts = confirmed.filter((m) => ['fact', 'event', 'decision'].includes(m.type))
    const constraints = confirmed.filter((m) => m.type === 'constraint')
    const preferences = confirmed.filter((m) => m.type === 'preference')
    const todos = confirmed.filter((m) => m.type === 'todo')
    const methods = confirmed.filter((m) => m.type === 'method')
    const citations = [...new Map(memories.flatMap((m) => m.evidence.map((e) => [`${m.id}:${e.message_id}`, { memory_id: m.id, message_id: e.message_id, quote: e.quote }])).map((x) => [x[0], x[1]])).values()]
    const scoreById = new Map(retrieval.meta.top.map((x) => [x.memory_id, x]))
    const whyOf = (m) => {
      const hit = scoreById.get(m.id)
      return `召回：scope=${m.scope_type}/${m.scope_id || 'all'}; status=${m.status}; confirmation=${m.confirmation}; protected=${m.protected ? 'yes' : 'no'}; evidence=${m.evidence.map((e) => e.message_id).join(',') || '无'}${hit ? `; 检索分=${hit.score}; 命中=${(hit.matched || []).join('/') || '范围/时近'}` : ''}`
    }
    const ruleWhy = (e) => `生效：authority=${e.rule.authority_label}(${e.rule.authority_rank}); scope=${e.rule.scope_type}/${e.rule.scope_id || 'all'}; strength=${e.rule.strength}; 条件=${e.reason}`
    const sections = {
      task_background: { project, task, task_id: taskId, object: ctx.object, state: ctx.state },
      instruction: instruction ? { text: instruction, authority: 'current_instruction', note: '当前会话显式指令，仅本次调用有效，不写入长期记忆' } : null,
      facts: facts.map((m) => ({ id: m.id, version: m.version, scope_type: m.scope_type, scope_id: m.scope_id, text: m.text, type: m.type, event_time: m.event_time, evidence: m.evidence, why: whyOf(m) })),
      constraints: constraints.map((m) => ({ id: m.id, version: m.version, scope_type: m.scope_type, scope_id: m.scope_id, text: m.text, evidence: m.evidence, why: whyOf(m) })),
      preferences: preferences.map((m) => ({ id: m.id, version: m.version, scope_type: m.scope_type, scope_id: m.scope_id, text: m.text, evidence: m.evidence, why: whyOf(m) })),
      suggestions: suggestions.map((m) => ({ id: m.id, version: m.version, scope_type: m.scope_type, scope_id: m.scope_id, text: m.text, type: m.type, source_category: m.source_category, confirmation: m.confirmation, note: '未确认的模型建议，不能当作已确认事实' })),
      todos: todos.map((m) => ({ id: m.id, version: m.version, scope_type: m.scope_type, scope_id: m.scope_id, text: m.text, status: m.status, why: whyOf(m) })),
      methods: methods.map((m) => ({ id: m.id, version: m.version, scope_type: m.scope_type, scope_id: m.scope_id, text: m.text, why: whyOf(m) })),
      objects: objectRows.map((o) => ({ id: o.id, type: o.type_id, name: o.name, current_state: o.current_state, candidate: !!o.candidate, properties: o.properties, state_history: o.state_history.slice(-5) })),
      rules: applicable.map((e) => ({
        id: e.rule.id, version: e.rule.version, scope_type: e.rule.scope_type, scope_id: e.rule.scope_id, name: e.rule.name, category: e.rule.category, strength: e.rule.strength,
        authority: e.rule.authority, authority_label: e.rule.authority_label, authority_rank: e.rule.authority_rank,
        actions: e.rule.actions, exceptions: e.rule.exceptions, acceptance: e.rule.acceptance,
        conditions: e.conditions, why: ruleWhy(e),
      })),
      conflicts: {
        memories: [...memGroups.values()],
        rules: ruleConflictList.map((c) => ({
          key: c.key, a: c.a_id, b: c.b_id, reason: c.reason, resolution: c.resolution,
          auto_resolution: c.auto_resolution, adjudicated: !!c.adjudicated, unresolved: !!c.unresolved,
          manual: c.manual || null, precedence: c.precedence,
          note: c.manual ? `人工裁决：${c.manual.resolution}${c.manual.note ? `（${c.manual.note}）` : ''}` : c.unresolved ? '未裁决：保留冲突，不当作已解决' : '自动优先级建议；未人工裁决时保留双方记录',
        })),
      },
      unknowns: [
        ...unknownRules.map((e) => ({ rule_id: e.rule.id, name: e.rule.name, strength: e.rule.strength, actions: e.rule.actions, reason: e.reason, note: '条件数据缺失，受影响动作必须先完成验证' })),
        ...memories.filter((m) => m.status === 'conflict').map((m) => ({ memory_id: m.id, text: m.text, reason: '存在冲突，未进入已确认事实区' })),
      ],
      actions: applicable.flatMap((e) => (Array.isArray(e.rule.actions) ? e.rule.actions : [])
        .filter(() => e.rule.category !== 'permission')
        .map((action) => ({
          rule_id: e.rule.id, rule_name: e.rule.name, category: e.rule.category, strength: e.rule.strength, action,
          execution: (e.rule.strength === 'must_not' || BLOCK_ACTION.test(actionTypeOf(action))) ? 'blocked' : 'requires_authorization',
          note: (e.rule.strength === 'must_not' || BLOCK_ACTION.test(actionTypeOf(action))) ? '约束动作，禁止执行' : '规则生效不等于执行授权；需单独校验',
        }))),
      retrieval: retrieval.meta,
      citations,
      filtered: {
        sensitive: sensitiveFiltered.length,
        sensitive_included: includeSensitive,
        out_of_scope: allMemories.length - inScope.length,
        retrieval_truncated: retrieval.meta.truncated,
        retrieval_candidates: retrieval.meta.candidate_count,
        adjudicated_excluded: excludedByResolution.length,
        paused_rules: db.prepare("SELECT COUNT(*) AS n FROM loop_rules WHERE owner=? AND governance_status='paused'").get(owner).n,
        expired_rules: db.prepare("SELECT COUNT(*) AS n FROM loop_rules WHERE owner=? AND governance_status='active' AND valid_to IS NOT NULL AND valid_to<=?").get(owner, nowIso).n,
      },
      why: memories.map((m) => ({ memory_id: m.id, why: whyOf(m) })),
    }
    sections.precedence = ['current_instruction', 'task_constraint', 'project_rule', 'domain_rule', 'personal_preference', 'model_suggestion']
      .map((key) => ({ key, label: AUTHORITY_LABEL[key], rules: applicable.filter((e) => e.rule.authority === key).map((e) => e.rule.id) }))
    if (instruction) Object.assign(sections.precedence[0], { rules: [], active: true, note: '当前会话显式指令' })
    sections.precedence = sections.precedence.filter((x) => x.rules.length || x.active)
    const hardChars = JSON.stringify({
      instruction: sections.instruction,
      constraints: sections.constraints,
      hardRules: sections.rules.filter((r) => ['must', 'must_not'].includes(r.strength)),
      conflicts: sections.conflicts,
    }).length
    const budget = Math.max(2000, Math.min(200_000, Number(body.budget) || maxContextChars))
    if (hardChars > budget) {
      const runId = uid('run')
      db.prepare('INSERT INTO loop_runs(id,request_json,context_json,budget,status,error,created_at) VALUES(?,?,?,?,?,?,?)').run(runId, JSON.stringify(body), '{}', budget, 'error', 'hard_constraints_exceed_budget', now())
      return { ok: false, error: 'hard_constraints_exceed_budget', hard_chars: hardChars, budget, suggestion: '缩小范围、减少硬约束或分步处理，不能静默丢弃硬约束' }
    }
    const runId = uid('run')
    db.prepare('INSERT INTO loop_runs(id,request_json,context_json,budget,status,error,created_at) VALUES(?,?,?,?,?,?,?)').run(runId, JSON.stringify({ ...body, owner }), JSON.stringify(sections), budget, 'ok', '', now())
    audit('context.build', 'run', runId, { memories: memories.length, rules: evaluations.length, sensitive_filtered: sensitiveFiltered.length, retrieval_truncated: retrieval.meta.truncated })
    return {
      ok: true, run_id: runId, budget, usage: JSON.stringify(sections).length, sections,
      evaluations: evaluations.map((e) => ({ rule_id: e.rule.id, name: e.rule.name, strength: e.rule.strength, authority: e.rule.authority, authority_label: e.rule.authority_label, result: e.result, reason: e.reason, conditions: e.conditions, excluded_by_resolution: e.excluded_by_resolution || null, adjudicated: e.adjudicated || null })),
    }
  }

  function captureChatTurn({conversation_id,turn_id,messages=[],project=null,task=null,modelSelection=null} = {}) {
    if(!conversation_id || turn_id==null)throw new Error('chat_turn_identity_required')
    const externalId=`dsh-auto:${encodeURIComponent(conversation_id)}:${encodeURIComponent(String(turn_id))}`
    const existing=db.prepare("SELECT * FROM loop_sources WHERE owner='local-user' AND external_conversation_id=?").get(externalId)
    if(existing) {
      const job=db.prepare('SELECT * FROM loop_jobs WHERE source_id=? ORDER BY created_at DESC LIMIT 1').get(existing.id)
      return {ok:true,duplicate:true,source_id:existing.id,job_id:job?.id || null,status:job?.status || 'saved'}
    }
    const visible=messages.filter(message=>['user','assistant'].includes(message?.role) && (!message.source || message.source.kind==='user' || message.role==='assistant'))
      .map((message,index)=>({id:message.id || `turn-message-${index}`,role:message.role,content:typeof message.content==='string'?message.content:(Array.isArray(message.content)?message.content:[]).filter(part=>part.type==='text').map(part=>part.text || '').join('\n')}))
      .filter(message=>message.content.trim())
    if(!visible.some(message=>message.role==='user'))return {ok:true,status:'skipped',reason:'no_user_message'}
    const parsed=parseConversation(JSON.stringify({messages:visible}),'json')
    return tx(()=>{
      const created=createSource({kind:'dsh-auto',platform:'dsh',externalConversationId:externalId,title:`聊天记忆 · ${visible.find(message=>message.role==='user').content.slice(0,60)}`,project,task},parsed)
      if(!modelSelection?.provider || !modelSelection?.model)return {ok:true,status:'saved',reason:'model_selection_missing',source_id:created.source.id}
      const queued=enqueueExtractJob(created.source,{modelSelection})
      return {ok:true,status:'queued',source_id:created.source.id,job_id:queued.job.id,duplicate:false}
    })
  }

  function inferConversationScope({cwd,query='',project_id} = {}) {
    const normalize=value=>String(value || '').replace(/\\/g,'/').replace(/\/+$/,'')
    const workspace=normalize(cwd)
    const projectName=workspace.split('/').at(-1) || null
    const projects=new Set()
    for(const table of ['loop_sources','loop_memories','loop_rules','loop_ontology_instances']) {
      for(const row of db.prepare(`SELECT DISTINCT project FROM ${table} WHERE owner='local-user' AND project IS NOT NULL`).all()) projects.add(row.project)
    }
    for(const table of ['loop_memories','loop_rules']) {
      for(const row of db.prepare(`SELECT DISTINCT scope_id FROM ${table} WHERE owner='local-user' AND scope_type='project' AND scope_id IS NOT NULL`).all()) projects.add(row.scope_id)
    }
    const compare=value=>/^[a-z]:/i.test(value)?value.toLowerCase():value
    const exact=[...projects].filter(value=>compare(normalize(value))===compare(workspace))
    const names=[...projects].filter(value=>value===projectName)
    const project=project_id || (workspace ? exact[0] || (names.length===1?names[0]:workspace) : null)
    const objects=db.prepare("SELECT id,name,aliases_json FROM loop_ontology_instances WHERE owner='local-user' AND status='active' AND candidate=0 AND project IS ?").all(project)
    const mentions=objects.filter(row=>[row.id,row.name,...json(row.aliases_json,[])].some(value=>{
      if(typeof value!=='string' || value.length<2)return false
      const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
      return /^[\w-]+$/.test(value)?new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`,'i').test(query):query.includes(value)
    }))
    const object=mentions.length===1?mentions[0]:null
    return {project_id:project,project_name:project_id || projectName,workspace:cwd || null,object_id:object?.id || null,object_name:object?.name || null}
  }

  ensureOntologyBaseline()
  startWorker()

  return { handle, buildContext, checkAction: evaluateActions, submitFeedback, importLegacyRule, withdrawLegacyRule, captureChatTurn, setChatExtractionModel, inferConversationScope, db, dbPath, close: () => { stopWorker(); db.close() } }
}
