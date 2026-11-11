/**
 * @fuxing/dsh-brain — host 半边。
 *
 * 把「星河大脑」页面接进 Harness：
 *   - 在 webServer 上注册一条前缀路由 `<prefix>/*`，静态服务打包的 web/（含 ~17MB
 *     皮层与 three.js 资源），并在 index.html 的 </head> 前注入
 *     `window.__MC_API_BASE__`，让页面知道自己的 API 基址；
 *   - 在 `<prefix>/api/*` 上提供页面所需的只读 JSON 契约：默认读包内
 *     `web/data/payload.json`（缺省退回 `web/data/demo.json`），按文件 mtime 缓存，
 *     直接改文件即可生效，不用重启。
 *
 * 核心运行时负责 SQLite、后台任务与模型接入；Web 半边提供管理接口和静态资源。
 * 路由仅接受本机访问，并对浏览器来源和私人数据路径进行检查。
 */
import { createReadStream, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { createRulesRuntime } from './rules.js'
import { createLoopRuntime } from './loop.js'
import { createExecutionStore } from './execution-store.js'
import { createDshIntegration } from './dsh-integration.js'

export const name = 'dsh-memory-brain'

/** 核心不依赖 Web；页面路由通过子注入可选装载。 */
export const inject = []

/** 包内 Web 根目录（本文件在 lib/，上一级就是 web/）。 */
const PACKAGED_WEB_ROOT = fileURLToPath(new URL('../web', import.meta.url))

export const Config = z.object({
  /** 对外 URL 前缀；client 半边的 iframe 也用它。 */
  prefix: z.string().description('对外 URL 前缀（页面与 API 都挂在这里）。').default('/memory-brain'),
  /** 数据包 JSON 的绝对路径；留空 = <root>/data/payload.json，再缺省退回 demo.json。 */
  payload: z.string().description('数据包 JSON 绝对路径；留空 = <root>/data/payload.json（再退回 demo.json）。').default(''),
  /** 页面根目录；留空 = 包内 web/。 */
  root: z.string().description('页面根目录（含 index.html / styles / src / assets / data）；留空 = 包内 web/。').default(''),
  /** 规则提炼的语料目录；留空 = <包根>/corpus。 */
  corpus: z.string().description('规则提炼语料目录；留空 = <包根>/corpus。').default(''),
  /** 规则库 JSON；留空 = <root>/data/rules.json。 */
  rules: z.string().description('规则库 JSON 路径；留空 = <root>/data/rules.json。').default(''),
  /** 本地/远程 OpenAI 兼容端点（不要带 /chat/completions）。 */
  rulesEndpoint: z.string().description('规则提炼的 OpenAI 兼容端点（如 http://127.0.0.1:8080/v1）。').default('http://127.0.0.1:8080/v1'),
  rulesModel: z.string().description('规则提炼模型 id。').default('qwen3.8-flash-next'),
  rulesApiKeyEnv: z.string().description('可选：存 API Key 的环境变量名。').default(''),
  rulesMaxChunks: z.number().description('单次最多送检的语料分块数。').default(40),
  rulesMaxSessions: z.number().description('单次最多读取多少个 DSH 历史会话。').default(100),
  workspace: z.string().description('工作区绝对路径；留空 = 当前工作区 registry 第一项。').default(''),
  loopDb: z.string().description('闭环 SQLite 路径；留空 = <root>/data/loop.db。').default(''),
  loopTimeoutMs: z.number().description('闭环模型提取超时毫秒。').default(120000),
  loopContextChars: z.number().description('上下文硬约束预算字符数。').default(20000),
  contextWindow: z.number().description('宿主没有模型窗口元数据时的回退窗口（token）；0 = 不声明回退，窗口未知时跳过请求预算拦截（交给宿主压缩）。').default(0),
  reservedOutput: z.number().description('模型未指定 maxTokens 时的回答预留（token）。').default(2048),
  loopWorker: z.boolean().description('启用持久任务 worker。').default(true),
  loopAutoExtract: z.boolean().description('正常聊天结束后自动提取记忆，复用本轮模型；处理新轮次，不回扫历史。').default(true),
  loopWorkerIntervalMs: z.number().description('任务轮询间隔毫秒。').default(1200),
  loopJobLeaseMs: z.number().description('任务租约毫秒，运行时自动续租。').default(300000),
  loopJobMaxAttempts: z.number().description('任务最大尝试次数。').default(3),
  loopEmbedEndpoint: z.string().description('OpenAI 兼容 embeddings 端点（完整 URL，如 http://127.0.0.1:8781/v1/embeddings）；留空 = 不启用向量召回。').default('http://127.0.0.1:8781/v1/embeddings'),
  loopEmbedModel: z.string().description('embedding 模型 id。').default('bge-m3'),
  loopEmbedApiKeyEnv: z.string().description('可选：embedding API Key 的环境变量名。').default(''),
  loopEmbedEnabled: z.boolean().description('是否启用向量召回；关闭时只用词法检索。').default(true),
  loopRuleReviewMode: z.string().description('AI 规则审核模式：auto 全自动（结构合法即生效）/ semi 半自动（默认；业务约束、权限、硬性禁令等人工确认）/ manual 手动（全部人工确认）；其他值按 semi 处理。页面规则中心可随时切换，页面切换值持久保存并优先于本配置。').default('semi'),
})

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

/** @param {import('node:http').ServerResponse} res */
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

function sendError(res, status, message) {
  sendJson(res, { ok: false, error: message }, status)
}

async function readJsonBody(req) {
  let text = ''
  for await (const chunk of req) text += chunk
  if (!text) return {}
  try { return JSON.parse(text) } catch { throw Object.assign(new Error('invalid_json'), { status: 400 }) }
}

function normalizePrefix(raw) {
  let prefix = String(raw ?? '').trim()
  if (!prefix) prefix = '/memory-brain'
  if (!prefix.startsWith('/')) prefix = `/${prefix}`
  prefix = prefix.replace(/\/+$/, '')
  return prefix || '/memory-brain'
}

/** 把 URL 相对路径拼到 root 下，并保证结果不逃出 root。 */
function safeJoin(root, rel) {
  const target = resolve(root, `.${rel}`)
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 显式配置的 payload 优先；否则 payload.json → demo.json，都不存在时保留主路径用于报错。 */
function resolvePayloadPath(config, root) {
  const explicit = String(config.payload ?? '').trim()
  if (explicit) return resolve(explicit)
  const main = join(root, 'data', 'payload.json')
  if (isFile(main)) return main
  const demo = join(root, 'data', 'demo.json')
  if (isFile(demo)) return demo
  // 开源仓库只带脱敏样例；真实 payload 由用户本地生成/保留，不入库。
  const sample = join(root, 'data', 'sample-payload.json')
  if (isFile(sample)) return sample
  return main
}

function clampLimit(raw, fallback) {
  const n = Number(raw ?? fallback)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), 50)
}

export function apply(ctx, config) {
  const root = resolve(String(config.root ?? '').trim() || PACKAGED_WEB_ROOT)
  const loop = createLoopRuntime({ root, config, logger: ctx.logger })
  const executionStore = createExecutionStore(loop.db)
  createDshIntegration({ ctx, runtime: loop, executionStore, config, logger: ctx.logger })
  ctx.effect(() => () => loop.close(), 'memory-brain: close loop runtime')
  ctx.inject(['webServer'], (ctx) => {
    const prefix = normalizePrefix(config.prefix)
    const payloadPath = resolvePayloadPath(config, root)
    const payloadName = basename(payloadPath)
    const rules = createRulesRuntime({ root, config, logger: ctx.logger, workspaceRegistry: ctx.get('workspaceRegistry'), onAdopt:rule=>loop.importLegacyRule(rule), onWithdraw:id=>loop.withdrawLegacyRule(id) })

    // ---- payload：按 mtime 缓存，改文件不用重启 ----
    let cache = { mtimeMs: Number.NaN, data: null, error: '' }

    async function payload() {
      let st
      try {
        st = statSync(payloadPath)
      } catch (e) {
        throw new Error(`数据包不可读：${payloadPath}（${e.code ?? e.message}）`)
      }
      if (!st.isFile()) throw new Error(`数据包不可读：${payloadPath}（不是文件）`)
      if (st.mtimeMs !== cache.mtimeMs) {
        try {
          cache = { mtimeMs: st.mtimeMs, data: JSON.parse(await readFile(payloadPath, 'utf8')), error: '' }
        } catch (e) {
          cache = { mtimeMs: st.mtimeMs, data: null, error: `数据包解析失败：${payloadPath}（${e.message}）` }
        }
      }
      if (cache.error) throw new Error(cache.error)
      return cache.data
    }

    // ---- 数据整形（与 web/src/api.js 的契约保持一致）----
    function entities(p) {
      const map = new Map((p?.graph?.nodes ?? []).map((n) => [n.id, n]))
      for (const n of p?.entityIndex ?? []) if (!map.has(n.id)) map.set(n.id, n)
      return map
    }

    function relations(p) {
      return p?.allRelations ?? p?.graph?.edges ?? []
    }

    function nodeRelations(p, id) {
      const map = entities(p)
      const node = map.get(id)
      if (!node) return null
      const items = []
      for (const e of relations(p)) {
        if (e.src !== id && e.dst !== id) continue
        const otherId = e.src === id ? e.dst : e.src
        const other = map.get(otherId)
        if (!other) continue
        items.push({
          id: other.id,
          name: other.name,
          type: other.type,
          kind: e.kind,
          label: e.label,
          weight: e.weight,
        })
      }
      items.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      return { node, items }
    }

    function memoryDetail(m) {
      return {
        id: `m${m.id}`,
        sourceId: m.id,
        name: m.text,
        text: m.text,
        type: 'memory',
        kind: m.kind,
        tone: m.tone,
        importance: m.importance,
        created_at: m.created_at,
      }
    }

    function entityDetail(p, node) {
      const rel = nodeRelations(p, node.id)
      const items = rel ? rel.items : []
      return {
        id: `e${node.id}`,
        sourceId: node.id,
        name: node.name,
        text: node.name,
        type: node.type,
        kind: node.type,
        degree: node.degree ?? 0,
        relationCount: items.length,
        associations: items.slice(0, 12),
      }
    }

    /** raw 可带 e/m 前缀（e7 / m112）；不带前缀时先按实体、再按记忆查找。 */
    function nodeDetail(p, raw) {
      const text = String(raw ?? '')
      const id = Number(text.replace(/^[em]/, ''))
      if (!Number.isFinite(id)) return null
      const findMemory = () => (p?.graph?.memories ?? p?.memories ?? []).find((m) => String(m.id) === String(id))
      const findEntity = () => entities(p).get(id)
      if (text.startsWith('m')) {
        const m = findMemory()
        if (m) return memoryDetail(m)
        const n = findEntity()
        return n ? entityDetail(p, n) : null
      }
      const n = findEntity()
      if (n) return entityDetail(p, n)
      const m = findMemory()
      return m ? memoryDetail(m) : null
    }

    function search(p, q, limit) {
      if (!q) return { query: q, items: [], total: 0 }
      const ql = q.toLowerCase()
      const hits = []
      for (const m of p?.graph?.memories ?? p?.memories ?? []) {
        const text = String(m.text ?? '')
        if (!text.toLowerCase().includes(ql)) continue
        hits.push({
          id: `m${m.id}`,
          sourceId: m.id,
          type: 'memory',
          kind: m.kind,
          tone: m.tone,
          text,
          name: text,
          created_at: m.created_at,
          score: m.importance ?? 0.5,
        })
      }
      for (const n of p?.graph?.nodes ?? []) {
        if (!String(n.name).toLowerCase().includes(ql)) continue
        hits.push({
          id: `e${n.id}`,
          sourceId: n.id,
          type: 'node',
          kind: n.type,
          text: n.name,
          name: n.name,
          score: 1 + Math.min(n.degree ?? 0, 50) / 100,
        })
      }
      hits.sort((a, b) => b.score - a.score)
      return { query: q, items: hits.slice(0, limit), total: hits.length }
    }

    // ---- 只读 API ----
    async function handleApi(req, res, url, rel) {
      const seg = rel.slice('/api'.length) || '/'
      const qs = url.searchParams

      if (seg === '/health') {
        try {
          const p = await payload()
          return sendJson(res, {
            ok: true,
            prefix,
            payload: payloadName,
            source: p?.source ?? null,
            version: p?.version ?? null,
            generatedAt: p?.generatedAt ?? null,
            counts: {
              nodes: p?.graph?.nodes?.length ?? 0,
              edges: relations(p).length,
              memories: p?.graph?.memories?.length ?? p?.memories?.length ?? 0,
            },
          })
        } catch (e) {
          return sendError(res, 503, String(e?.message ?? e))
        }
      }

      let p
      try {
        p = await payload()
      } catch (e) {
        return sendError(res, 503, String(e?.message ?? e))
      }

      if (seg === '/all' || seg === '/') return sendJson(res, p)
      if (seg === '/overview') return sendJson(res, p?.overview ?? null)
      if (seg === '/graph') return sendJson(res, p?.graph ?? null)
      if (seg === '/recent') {
        const rows = p?.recent ?? p?.memories ?? p?.graph?.memories ?? []
        return sendJson(res, rows.slice(0, clampLimit(qs.get('limit'), 5)))
      }
      if (seg === '/search') return sendJson(res, search(p, (qs.get('q') ?? '').trim(), clampLimit(qs.get('limit'), 8)))

      if (seg.startsWith('/node/')) {
        const raw = decodeURIComponent(seg.slice('/node/'.length))
        const wantsRelations = raw.endsWith('/relations')
        const key = wantsRelations ? raw.slice(0, -'/relations'.length) : raw
        const detail = nodeDetail(p, key)
        if (!detail) return sendError(res, 404, `节点不存在：${key}`)
        if (wantsRelations) {
          return sendJson(res, {
            id: detail.id,
            name: detail.name,
            relationCount: detail.relationCount ?? 0,
            items: detail.associations ?? [],
          })
        }
        return sendJson(res, detail)
      }

      return sendError(res, 404, `未知 API：${seg}`)
    }

    // ---- 静态页面 + API 分发 ----
    async function handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const origin = req.headers?.origin
      const host = req.headers?.host
      const remote = req.socket?.remoteAddress
      if (remote && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return sendError(res, 403, 'local_access_only')
      if (host) {
        try { if (!['localhost','127.0.0.1','[::1]'].includes(new URL(`http://${host}`).hostname)) return sendError(res,403,'host_not_allowed') }
        catch { return sendError(res,403,'host_not_allowed') }
      }
      if (req.headers?.['sec-fetch-site'] === 'cross-site') return sendError(res, 403, 'cross_site_request')
      if (origin) {
        try { if (!host || new URL(origin).host !== host) return sendError(res, 403, 'origin_not_allowed') }
        catch { return sendError(res, 403, 'origin_not_allowed') }
      }
      const pathname = url.pathname
      if (pathname === '/memory-brain-config' && req.method === 'GET') return sendJson(res,{ok:true,prefix})
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
        res.writeHead(404).end()
        return
      }
      let rel = pathname.slice(prefix.length) || '/'
      const isRulesApi = rel === '/api/rules' || rel.startsWith('/api/rules/')
      const isLoopApi = rel === '/api/loop' || rel.startsWith('/api/loop/')
      if (req.method !== 'GET' && req.method !== 'HEAD' && !(isRulesApi && req.method === 'POST') && !isLoopApi) {
        sendError(res, 405, '该路由只读；写入只支持 /api/rules/* 与 /api/loop/*')
        return
      }
      if (isRulesApi) {
        await rules.handle(req, res, url)
        return
      }
      if (isLoopApi) {
        const route = rel.slice('/api/loop'.length)
        if (route === '/invocations' || route.startsWith('/invocations/')) {
          if (req.method === 'GET') {
            if (route === '/invocations') return sendJson(res, executionStore.list(url.searchParams.get('conversation_id') || url.searchParams.get('session_id') || ''))
            const item = executionStore.get(route.slice('/invocations/'.length)); return sendJson(res, item || {ok:false,error:'not_found'}, item ? 200 : 404)
          }
        }
        if (route === '/scope' && req.method === 'GET') {
          try {
            const scope=executionStore.scope(url.searchParams.get('conversation_id') || url.searchParams.get('session_id'))
            if(scope.auto_extraction?.job_id) {
              const job=loop.db.prepare("SELECT status,error,result_json FROM loop_jobs WHERE id=? AND owner='local-user'").get(scope.auto_extraction.job_id)
              if(job){const result=JSON.parse(job.result_json || '{}');scope.auto_extraction={...scope.auto_extraction,status:job.status,error:job.error,memories_added:result.memories_added || 0,rules_added:result.rules_added || 0}}
            }
            return sendJson(res,{ok:true,scope,auto_extract_enabled:config.loopAutoExtract!==false})
          } catch (e) { return sendError(res,400,e.message) }
        }
        if (route === '/scope' && req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const id = body.conversation_id || body.session_id
            const patch = Object.fromEntries(['project_id','task_id','task_description','object_id','object_name','mode','ignored_by_turn','ignore_next_turn','preview_approval','auto_extract'].filter(key=>Object.hasOwn(body,key)).map(key=>[key,body[key]]))
            const edited=['project_id','task_id','task_description','object_id','object_name'].filter(key=>Object.hasOwn(body,key))
            if(edited.length) {
              patch.auto_scope={...(executionStore.scope(id).auto_scope || {})}
              for(const key of edited) delete patch.auto_scope[key]
              if(Object.hasOwn(body,'project_id')) patch.project_name=body.project_id || null
              if(Object.hasOwn(body,'object_id')) {
                patch.object_name=null
                delete patch.auto_scope.object_name
                const project=Object.hasOwn(body,'project_id')?body.project_id:executionStore.scope(id).project_id
                const object=loop.db.prepare("SELECT name FROM loop_ontology_instances WHERE id=? AND owner='local-user' AND (project IS NULL OR project IS ?)").get(body.object_id || '',project || null)
                if(object)patch.object_name=object.name
              }
            }
            if (body.preview_cancel === true) { patch.preview=null;patch.preview_approval=null }
            if (patch.preview_approval && patch.preview_approval !== executionStore.scope(id).preview?.fingerprint) return sendError(res,409,'stale_preview')
            return sendJson(res,{ok:true,scope:executionStore.scope(id,patch)})
          } catch (e) { return sendError(res, e.status || 400, e.message) }
        }
        if (route === '/feedback' && req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            if (!body.invocation_id) return sendJson(res, loop.submitFeedback(body))
            const invocation = executionStore.get(body.invocation_id)
            if (!invocation) return sendError(res, 404, 'invocation_not_found')
            const normalized = { ...body, owner: 'local-user', run_id: invocation.context_run_id || null, outcome: body.outcome === 'helpful' ? 'useful' : body.outcome }
            const result = loop.submitFeedback(normalized)
            executionStore.feedback({ ...normalized, id: result.id })
            return sendJson(res, result, 201)
          } catch (e) { return sendError(res, e.status || 400, e.message) }
        }
        await loop.handle(req, res, url, route)
        return
      }
      if (rel === '/api' || rel.startsWith('/api/')) {
        await handleApi(req, res, url, rel)
        return
      }
      if (rel === '' || rel === '/') rel = '/index.html'
      if (rel.endsWith('/')) rel += 'index.html'

      try { rel = decodeURIComponent(rel).replace(/\\/g, '/') } catch { return sendError(res, 400, 'invalid_path') }
      if (/(^|\/)\./.test(rel) || /\.(?:db|sqlite|sqlite3)(?:$|[-.])/i.test(rel)
        || (rel.toLowerCase().startsWith('/data/') && !['/data/sample-payload.json', '/data/readme.md'].includes(rel.toLowerCase()))) {
        return sendError(res, 403, 'runtime_data_not_public')
      }

      const file = safeJoin(root, rel)
      if (file === null) {
        sendError(res, 403, '路径越界')
        return
      }
      let st
      try {
        st = statSync(file)
      } catch {
        sendError(res, 404, `找不到：${rel}`)
        return
      }
      if (!st.isFile()) {
        sendError(res, 404, `找不到：${rel}`)
        return
      }

      const ext = extname(file).toLowerCase()
      const headers = {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      }
      if (ext === '.html') {
        // 页面内 src/api.js 优先读 window.__MC_API_BASE__，能感知自己被挂在哪个前缀下。
        let html = await readFile(file, 'utf8')
        const script = `<script>window.__MC_API_BASE__ = ${JSON.stringify(`${prefix}/api`)}</script>`
        html = html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`
        const body = Buffer.from(html, 'utf8')
        headers['Content-Length'] = String(body.length)
        res.writeHead(200, headers)
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }
      headers['Content-Length'] = String(st.size)
      res.writeHead(200, headers)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      const stream = createReadStream(file)
      stream.on('error', () => {
        try {
          res.destroy()
        } catch {
          /* 响应已结束 */
        }
      })
      stream.pipe(res)
    }

    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: prefix, handler }),
      'memory-brain: packaged web root + read-only api',
    )
    ctx.effect(() => ctx.webServer.register({kind:'exact',path:'/memory-brain-config',handler}), 'memory-brain: client prefix discovery')
    ctx.logger?.info?.(`[memory-brain] ${prefix}/ ← ${root}（payload: ${payloadPath}）`)
  })
}
