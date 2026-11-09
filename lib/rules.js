/**
 * 规则提炼运行时（host 半边）
 *
 * 读取 <project>/corpus 下的文本语料，调用本地 OpenAI 兼容接口
 * （默认 http://127.0.0.1:8080/v1，qwen3.8-flash-next）提炼规则，
 * 写入 web/data/rules.json：
 *   - candidates：待人工确认的候选规则
 *   - rules：已采纳的规则
 *
 * 页面只读展示与触发，不接触模型凭据；模型调用在这里完成。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log'])
const SKIP_NAMES = new Set(['readme.md', 'readme.txt', '.gitkeep', 'package.json', 'package-lock.json'])
const RULE_TYPES = ['preference', 'boundary', 'workflow', 'principle']
const TYPE_LABELS = { preference: '偏好', boundary: '边界', workflow: '流程', principle: '原则' }

function sendJson(res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function ruleKey(type, condition, action) {
  return createHash('sha1').update(`${type}\u0000${normalizeText(condition).toLowerCase()}\u0000${normalizeText(action).toLowerCase()}`).digest('hex').slice(0, 10)
}

function defaultStore() {
  return {
    version: 1,
    updatedAt: null,
    model: '',
    corpus: { dir: '', files: 0, chars: 0, chunks: 0, truncated: false, scannedAt: null },
    candidates: [],
    rules: [],
  }
}

function parseModelJson(text) {
  let raw = String(text || '').trim()
  if (!raw) return null
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  raw = raw.slice(start, end + 1)
  try {
    const obj = JSON.parse(raw)
    if (Array.isArray(obj)) return { rules: obj }
    if (obj && Array.isArray(obj.rules)) return obj
    return null
  } catch {
    return null
  }
}

function clampConfidence(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0.5
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n))
}

function chunkText(text, size = 6000, overlap = 300) {
  const clean = String(text || '').replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
  if (!clean) return []
  const chunks = []
  let at = 0
  while (at < clean.length) {
    let end = Math.min(clean.length, at + size)
    if (end < clean.length) {
      const slice = clean.slice(at, end)
      const cut = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('。'), slice.lastIndexOf('. '))
      if (cut > size * 0.55) end = at + cut + 1
    }
    chunks.push(clean.slice(at, end))
    if (end >= clean.length) break
    at = Math.max(at + 1, end - overlap)
  }
  return chunks
}

export function createRulesRuntime({ root, config = {}, logger, workspaceRegistry } = {}) {
  const projectRoot = resolve(root, '..')
  const corpusDir = resolve(String(config.corpus || '').trim() || join(projectRoot, 'corpus'))
  const rulesPath = resolve(String(config.rules || '').trim() || join(root, 'data', 'rules.json'))
  const endpoint = String(config.rulesEndpoint || 'http://127.0.0.1:8080/v1').replace(/\/+$/, '')
  const model = String(config.rulesModel || 'qwen3.8-flash-next')
  const apiKeyEnv = String(config.rulesApiKeyEnv || '').trim()
  const maxChunks = Math.max(1, Math.min(200, Number(config.rulesMaxChunks) || 40))
  const maxFiles = Math.max(1, Math.min(500, Number(config.rulesMaxFiles) || 100))
  const maxSessions = Math.max(1, Math.min(500, Number(config.rulesMaxSessions) || 100))
  const requestTimeoutMs = Math.max(30_000, Math.min(600_000, Number(config.rulesTimeoutMs) || 180_000))
  const dshHome = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  const workspaceOverride = String(config.workspace || '').trim()

  let store = defaultStore()
  let storeLoaded = false
  let state = { state: 'idle', startedAt: null, finishedAt: null, progress: { done: 0, total: 0 }, message: '未提炼', error: '' }
  let currentWorkspace = null

  async function loadStore() {
    if (storeLoaded) return store
    try {
      const raw = await readFile(rulesPath, 'utf8')
      const parsed = JSON.parse(raw)
      store = { ...defaultStore(), ...parsed }
      if (!Array.isArray(store.candidates)) store.candidates = []
      if (!Array.isArray(store.rules)) store.rules = []
    } catch {
      store = defaultStore()
    }
    storeLoaded = true
    return store
  }

  async function saveStore() {
    store.updatedAt = new Date().toISOString()
    await mkdir(dirname(rulesPath), { recursive: true })
    const tmp = `${rulesPath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
    await rename(tmp, rulesPath)
    storeLoaded = true
  }

  function publicState() {
    return {
      ...state,
      rulesPath,
      corpusDir,
      model,
      endpoint,
      workspace: currentWorkspace ? { id: currentWorkspace.id, title: currentWorkspace.title, path: currentWorkspace.path, sessions: currentWorkspace.sessionIds?.length ?? 0 } : null,
    }
  }

  async function loadWorkspaceFromStorage() {
    try {
      const raw = await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8')
      const data = JSON.parse(raw)
      const id = data?.global?.defaultWorkspaceId
      const ws = id ? data?.tables?.workspaces?.[id] : null
      if (ws && ws.path) {
        return { id, path: ws.path, title: ws.title || ws.path, sessionIds: Array.isArray(ws.sessionIds) ? ws.sessionIds : [] }
      }
    } catch {
      /* 没有存储或格式不同 */
    }
    return null
  }

  async function pickWorkspace() {
    const list = workspaceRegistry?.list?.() || []
    if (workspaceOverride) {
      const wanted = resolve(workspaceOverride)
      const hit = list.find((w) => resolve(w.path) === wanted)
      return hit || { id: 'custom', path: wanted, title: wanted.split('/').filter(Boolean).pop() || wanted, sessionIds: [] }
    }
    if (list.length) return list[0]
    return await loadWorkspaceFromStorage()
  }

  function sessionRootFor(workspacePath) {
    const encoded = '--' + resolve(workspacePath).replace(/^\/+/, '').replace(/\/+/g, '-') + '--'
    return join(dshHome, 'sessions', encoded)
  }

  async function collectCorpusFiles() {
    const out = []
    async function walk(at, depth) {
      if (out.length >= maxFiles || depth > 8) return
      let entries
      try {
        entries = await readdir(at, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= maxFiles) break
        if (ent.name.startsWith('.')) continue
        const abs = join(at, ent.name)
        if (ent.isDirectory()) {
          if (ent.name === 'node_modules' || ent.name === '__pycache__') continue
          await walk(abs, depth + 1)
          continue
        }
        if (!ent.isFile()) continue
        const lower = ent.name.toLowerCase()
        if (SKIP_NAMES.has(lower)) continue
        if (!TEXT_EXTS.has(extname(lower))) continue
        const rel = relative(corpusDir, abs).split('\\').join('/')
        try {
          const text = await readFile(abs, 'utf8')
          if (text.trim()) out.push({ path: `corpus/${rel}`, source: 'corpus', text })
        } catch {
          /* 单文件读失败不影响其他文件 */
        }
      }
    }
    await walk(corpusDir, 0)
    return out
  }

  async function collectWorkspaceDocs(workspacePath) {
    const out = []
    const root = resolve(workspacePath)
    const skipDirs = new Set(['node_modules', '.git', 'dist', '.pnpm-store', '__pycache__', 'corpus', '.cache'])
    async function walk(at, depth) {
      if (out.length >= maxFiles || depth > 8) return
      let entries
      try {
        entries = await readdir(at, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= maxFiles) break
        if (ent.name.startsWith('.')) continue
        const abs = join(at, ent.name)
        if (ent.isDirectory()) {
          if (skipDirs.has(ent.name)) continue
          await walk(abs, depth + 1)
          continue
        }
        if (!ent.isFile()) continue
        if (extname(ent.name).toLowerCase() !== '.md') continue
        try {
          const text = await readFile(abs, 'utf8')
          if (!text.trim() || text.length > 800_000) continue
          const rel = relative(root, abs).split('\\').join('/')
          out.push({ path: `docs/${rel}`, source: 'docs', text })
        } catch {
          /* 单文件读失败不影响其他文件 */
        }
      }
    }
    await walk(root, 0)
    return out
  }

  function extractUserText(logText) {
    const parts = []
    for (const line of String(logText || '').split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        if (ev.type !== 'user/message') continue
        const source = ev.data?.source
        if (source?.kind !== 'user') continue
        const content = Array.isArray(ev.data?.content) ? ev.data.content : []
        const text = content.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n')
        if (text.trim()) parts.push(text.trim())
      } catch {
        /* 单行损坏跳过 */
      }
    }
    return parts.join('\n\n')
  }

  async function collectSessionLogs(workspace) {
    if (!workspace) return []
    const out = []
    const root = sessionRootFor(workspace.path)
    let ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.slice(0, maxSessions) : []
    if (!ids.length) {
      try {
        const entries = await readdir(root, { withFileTypes: true })
        ids = entries.filter((e) => e.isDirectory()).map((e) => e.name).slice(0, maxSessions)
      } catch {
        ids = []
      }
    }
    let chars = 0
    for (const id of ids) {
      if (chars > 2_000_000) break
      const file = join(root, String(id), 'session.v4.jsonl.zstd')
      try {
        const raw = await readFile(file)
        const text = extractUserText(zstdDecompressSync(raw).toString('utf8'))
        if (!text.trim()) continue
        const clipped = text.slice(0, 200_000)
        chars += clipped.length
        out.push({ path: `sessions/${id}`, source: 'sessions', text: clipped })
      } catch {
        /* 无日志/压缩损坏跳过 */
      }
    }
    return out
  }

  async function collectSources({ sources = {}, workspace = null } = {}) {
    const use = {
      corpus: sources.corpus !== false,
      docs: sources.docs === true,
      sessions: sources.sessions === true,
    }
    if (!use.corpus && !use.docs && !use.sessions) throw new Error('至少选择一个语料来源')
    const all = []
    let corpusFiles = 0
    let docsFiles = 0
    let sessionFiles = 0
    if (use.corpus) {
      const files = await collectCorpusFiles()
      corpusFiles = files.length
      all.push(...files)
    }
    if (use.docs) {
      if (!workspace) throw new Error('找不到当前工作区，无法扫描 MD 文档；请在 config.workspace 指定工作区路径')
      const files = await collectWorkspaceDocs(workspace.path)
      docsFiles = files.length
      all.push(...files)
    }
    if (use.sessions) {
      if (!workspace) throw new Error('找不到当前工作区，无法读取会话记录；请在 config.workspace 指定工作区路径')
      const files = await collectSessionLogs(workspace)
      sessionFiles = files.length
      all.push(...files)
    }
    return { files: all, counts: { corpusFiles, docsFiles, sessionFiles, totalFiles: all.length } }
  }

  async function callModel(messages) {
    const headers = { 'Content-Type': 'application/json' }
    if (apiKeyEnv && process.env[apiKeyEnv]) headers.Authorization = `Bearer ${process.env[apiKeyEnv]}`
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: 1800,
        stream: false,
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`模型返回 HTTP ${res.status}${body ? `：${body.slice(0, 240)}` : ''}`)
    }
    const data = await res.json()
    return data?.choices?.[0]?.message?.content ?? ''
  }

  const SYSTEM_PROMPT = [
    '你是「忆核大脑」的规则提炼器。请从用户提供的个人语料中提炼可以长期复用的个人规则。',
    '规则类型只限四种：',
    '- preference：偏好、喜好、倾向',
    '- boundary：边界、禁忌、不可接受的事',
    '- workflow：流程、步骤、做法',
    '- principle：原则、判断准则、价值观',
    '只输出 JSON，格式：',
    '{"rules":[{"type":"preference","condition":"触发条件（尽量简短，可为空字符串）","action":"规则内容/行动","confidence":0.0,"evidence":"原文中的一句短引文"}]}',
    '要求：',
    '1. 只提炼语料中真实存在、可复用的规则，不要总结全文，不要编造；',
    '2. 每条规则必须有 evidence 原文依据；',
    '3. 最多 8 条，没有规则就返回 {"rules":[]}；',
    '4. 不要输出 JSON 以外的任何文字。',
  ].join('\n')

  const running = () => state.state === 'running'

  async function runExtraction({ limit, sources } = {}) {
    if (running()) throw Object.assign(new Error('已有提炼任务在运行'), { code: 'BUSY' })
    const startedAt = new Date().toISOString()
    state = { state: 'running', startedAt, finishedAt: null, progress: { done: 0, total: 0 }, message: '读取语料…', error: '' }
    try {
      const workspace = await pickWorkspace()
      currentWorkspace = workspace
      const collected = await collectSources({ sources: sources || { corpus: true }, workspace })
      const files = collected.files
      if (!files.length) {
        throw new Error('没有可提炼的语料：请检查 corpus/ 目录，或勾选工作区 MD / DSH 会话来源')
      }
      const limitN = Math.max(1, Math.min(maxChunks, Number(limit) || maxChunks))
      const chunks = []
      let totalChunks = 0
      for (const f of files) {
        const pieces = chunkText(f.text)
        totalChunks += pieces.length
        for (let i = 0; i < pieces.length; i++) {
          if (chunks.length >= limitN) break
          chunks.push({ path: f.path, index: i, text: pieces[i] })
        }
        if (chunks.length >= limitN) break
      }
      const truncated = totalChunks > chunks.length
      const charCount = files.reduce((n, f) => n + f.text.length, 0)
      state.progress = { done: 0, total: chunks.length }
      state.message = `共 ${files.length} 个来源 / ${chunks.length} 个分块，开始提炼…`

      const seen = new Map()
      for (const r of [...store.candidates, ...store.rules]) {
        seen.set(ruleKey(r.type, r.condition, r.action), true)
      }
      let added = 0
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        state.message = `提炼中 ${i + 1}/${chunks.length}：${chunk.path}`
        let content = ''
        try {
          content = await callModel([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `语料文件：${chunk.path}\n\n${chunk.text}` },
          ])
        } catch (e) {
          logger?.warn?.(`[memory-brain] 规则提炼单块失败 ${chunk.path}: ${e.message}`)
          state.progress.done = i + 1
          continue
        }
        const parsed = parseModelJson(content)
        for (const raw of parsed?.rules || []) {
          const type = RULE_TYPES.includes(raw?.type) ? raw.type : 'principle'
          const condition = normalizeText(raw?.condition)
          const action = normalizeText(raw?.action)
          if (!action) continue
          const key = ruleKey(type, condition, action)
          if (seen.has(key)) continue
          seen.set(key, true)
          added += 1
          store.candidates.push({
            id: `c_${key}`,
            type,
            typeLabel: TYPE_LABELS[type],
            condition,
            action,
            confidence: clampConfidence(raw?.confidence),
            evidence: {
              source: chunk.path,
              quote: normalizeText(raw?.evidence).slice(0, 500),
            },
            createdAt: new Date().toISOString(),
          })
        }
        state.progress.done = i + 1
      }

      store.model = model
      store.corpus = {
        dir: corpusDir,
        files: files.length,
        chars: charCount,
        chunks: chunks.length,
        truncated,
        scannedAt: new Date().toISOString(),
        limitedBy: limitN,
        sources: collected.counts,
        workspace: workspace ? { id: workspace.id, title: workspace.title, path: workspace.path } : null,
      }
      await saveStore()
      state = {
        state: 'done',
        startedAt,
        finishedAt: new Date().toISOString(),
        progress: { done: chunks.length, total: chunks.length },
        message: `提炼完成：新增 ${added} 条候选规则`, 
        error: '',
      }
    } catch (e) {
      state = {
        state: 'error',
        startedAt,
        finishedAt: new Date().toISOString(),
        progress: state.progress,
        message: '提炼失败',
        error: String(e?.message || e),
      }
      logger?.warn?.(`[memory-brain] 规则提炼失败：${e?.message || e}`)
    }
  }

  async function readBody(req) {
    let size = 0
    const parts = []
    for await (const part of req) {
      size += part.length
      if (size > 256 * 1024) throw new Error('请求体过大')
      parts.push(part)
    }
    if (!parts.length) return {}
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  }

  async function handle(req, res, url) {
    const seg = url.pathname.replace(/^.*\/api\/rules/, '') || '/'
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (seg === '/' || seg === '') {
          const data = await loadStore()
          return sendJson(res, { ...data, status: publicState() })
        }
        if (seg === '/status') return sendJson(res, publicState())
        if (seg === '/sources') {
          const rawList = workspaceRegistry?.list?.() || []
          const fallback = rawList.length ? null : await loadWorkspaceFromStorage()
          const list = (rawList.length ? rawList : fallback ? [fallback] : []).map((w) => ({
            id: w.id,
            title: w.title,
            path: w.path,
            sessions: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
          }))
          return sendJson(res, { workspaces: list, current: publicState().workspace })
        }
        return sendJson(res, { error: 'unknown rules api' }, 404)
      }
      if (req.method === 'POST') {
        if (seg === '/extract') {
          if (running()) return sendJson(res, { error: '已有提炼任务在运行', status: publicState() }, 409)
          let body = {}
          try { body = await readBody(req) } catch (e) { return sendJson(res, { error: e.message }, 400) }
          runExtraction({ limit: body.limit, sources: body.sources }).catch((e) => logger?.warn?.(e))
          return sendJson(res, { ok: true, status: publicState() }, 202)
        }
        if (seg === '/approve' || seg === '/reject' || seg === '/delete') {
          let body
          try { body = await readBody(req) } catch (e) { return sendJson(res, { error: e.message }, 400) }
          const id = String(body.id || '')
          const data = await loadStore()
          if (seg === '/approve') {
            const idx = data.candidates.findIndex((r) => r.id === id)
            if (idx < 0) return sendJson(res, { error: '候选规则不存在' }, 404)
            const [c] = data.candidates.splice(idx, 1)
            data.rules.unshift({
              ...c,
              id: `r_${c.id.replace(/^c_/, '')}`,
              approvedAt: new Date().toISOString(),
            })
          } else if (seg === '/reject') {
            const idx = data.candidates.findIndex((r) => r.id === id)
            if (idx < 0) return sendJson(res, { error: '候选规则不存在' }, 404)
            data.candidates.splice(idx, 1)
          } else {
            const idx = data.rules.findIndex((r) => r.id === id)
            if (idx < 0) return sendJson(res, { error: '规则不存在' }, 404)
            data.rules.splice(idx, 1)
          }
          await saveStore()
          return sendJson(res, { ok: true, ...data, status: publicState() })
        }
        return sendJson(res, { error: 'unknown rules api' }, 404)
      }
      sendJson(res, { error: 'method not allowed' }, 405)
    } catch (e) {
      sendJson(res, { error: String(e?.message || e) }, 500)
    }
  }

  return { handle, publicState, loadStore, corpusDir, rulesPath }
}
