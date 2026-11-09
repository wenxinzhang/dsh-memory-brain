/**
 * @dafeiyu/dsh-memory-brain — host 半边。
 *
 * 把「忆核大脑」页面接进 Harness：
 *   - 在 webServer 上注册一条前缀路由 `<prefix>/*`，静态服务打包的 web/（含 ~17MB
 *     皮层与 three.js 资源），并在 index.html 的 </head> 前注入
 *     `window.__MC_API_BASE__`，让页面知道自己的 API 基址；
 *   - 在 `<prefix>/api/*` 上提供页面所需的只读 JSON 契约：默认读包内
 *     `web/data/payload.json`（缺省退回 `web/data/demo.json`），按文件 mtime 缓存，
 *     直接改文件即可生效，不用重启。
 *
 * 本插件不写任何状态、不启动后台任务，只做只读服务；路由只在 webServer 已绑定的
 * 地址上可达（默认 127.0.0.1）。
 */
import { createReadStream, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { createRulesRuntime } from './rules.js'
import { createLoopRuntime } from './loop.js'

export const name = 'dsh-memory-brain'

/** 只用可选的 webServer；没有它时整个 apply 不生效，插件本身没有硬依赖。 */
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
  loopEmbedEndpoint: z.string().description('OpenAI 兼容 embeddings 端点（完整 URL，如 http://127.0.0.1:8781/v1/embeddings）；留空 = 不启用向量召回。').default('http://127.0.0.1:8781/v1/embeddings'),
  loopEmbedModel: z.string().description('embedding 模型 id。').default('bge-m3'),
  loopEmbedApiKeyEnv: z.string().description('可选：embedding API Key 的环境变量名。').default(''),
  loopEmbedEnabled: z.boolean().description('是否启用向量召回；关闭时只用词法检索。').default(true),
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
  ctx.inject(['webServer'], (ctx) => {
    const root = resolve(String(config.root ?? '').trim() || PACKAGED_WEB_ROOT)
    const prefix = normalizePrefix(config.prefix)
    const payloadPath = resolvePayloadPath(config, root)
    const payloadName = basename(payloadPath)
    const rules = createRulesRuntime({ root, config, logger: ctx.logger, workspaceRegistry: ctx.get('workspaceRegistry') })
    const loop = createLoopRuntime({ root, config, logger: ctx.logger })

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
      const pathname = url.pathname
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
        await loop.handle(req, res, url, rel.slice('/api/loop'.length))
        return
      }
      if (rel === '/api' || rel.startsWith('/api/')) {
        await handleApi(req, res, url, rel)
        return
      }
      if (rel === '' || rel === '/') rel = '/index.html'
      if (rel.endsWith('/')) rel += 'index.html'

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
    ctx.logger?.info?.(`[memory-brain] ${prefix}/ ← ${root}（payload: ${payloadPath}）`)
  })
}
