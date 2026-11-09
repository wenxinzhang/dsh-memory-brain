#!/usr/bin/env node
/**
 * 本地闭环开发/验收服务器（不依赖 DSH 进程，便于浏览器端到端验证）。
 *
 *   node tools/loop-dev-server.mjs --port 18912 --db web/data/loop-verify.db
 *
 * - `/` 静态服务 web/，并在 index.html 注入 window.__MC_API_BASE__ = '/api'
 * - `/api/loop/*` 由 lib/loop.js 处理（真实 SQLite + 真实模型配置）
 * - `/api/all` 返回 web/data/payload.json，供中央 3D 大脑使用
 * - `/api/health` 返回闭环概览，便于确认服务已起
 */
import http from 'node:http'
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLoopRuntime } from '../lib/loop.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const pkgRoot = resolve(here, '..')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const root = resolve(arg('root', join(pkgRoot, 'web')))
const port = Number(arg('port', 18912))
const db = resolve(arg('db', join(root, 'data', 'loop-verify.db')))
const payloadPath = resolve(arg('payload', join(root, 'data', 'payload.json')))
const endpoint = arg('endpoint', 'http://127.0.0.1:8080/v1')
const model = arg('model', 'qwen3.8-flash-next')
const embedEndpoint = arg('embed-endpoint', 'http://127.0.0.1:8781/v1/embeddings')
const embedModel = arg('embed-model', 'bge-m3')

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream', '.woff2': 'font/woff2',
}
const sendJson = (res, obj, status = 200) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.length), 'Cache-Control': 'no-store' })
  res.end(body)
}
const runtime = createLoopRuntime({ root, config: { loopDb: db, rulesEndpoint: endpoint, rulesModel: model, loopEmbedEndpoint: embedEndpoint, loopEmbedModel: embedModel } })
const prefix = '/memory-brain'

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  let pathname = url.pathname
  if (pathname === prefix) pathname = '/'
  else if (pathname.startsWith(`${prefix}/`)) pathname = pathname.slice(prefix.length)
  try {
    if (pathname === '/api/loop' || pathname.startsWith('/api/loop/')) {
      return await runtime.handle(req, res, url, pathname.slice('/api/loop'.length))
    }
    if (pathname === '/api/all') {
      return sendJson(res, JSON.parse(await readFile(payloadPath, 'utf8')))
    }
    if (pathname === '/api/health') {
      const ov = await new Promise((resolve) => {
        const fake = { writeHead() {}, end(body) { resolve(JSON.parse(body)) } }
        runtime.handle(req, fake, new URL('http://x/api/loop/overview'), '/overview')
      })
      return sendJson(res, { ok: true, mode: 'dev-server', db, root, ...ov })
    }
    if (pathname === '/api/rules' || pathname.startsWith('/api/rules/')) {
      return sendJson(res, { ok: false, error: 'dev server 不提供规则提炼接口' }, 501)
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) return sendJson(res, { ok: false, error: '未知 API' }, 404)
    let rel = pathname === '/' ? '/index.html' : pathname
    const file = resolve(root, `.${rel}`)
    if (file !== root && !file.startsWith(root + sep)) return sendJson(res, { ok: false, error: '路径越界' }, 403)
    if (!existsSync(file) || !statSync(file).isFile()) return sendJson(res, { ok: false, error: `找不到 ${rel}` }, 404)
    const ext = extname(file).toLowerCase()
    if (ext === '.html') {
      let html = await readFile(file, 'utf8')
      const script = `<script>window.__MC_API_BASE__ = "/api"</script>`
      html = html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`
      const body = Buffer.from(html, 'utf8')
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': String(body.length), 'Cache-Control': 'no-store' })
      return res.end(req.method === 'HEAD' ? undefined : body)
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    return createReadStream(file).pipe(res)
  } catch (e) {
    console.error('[dev-server]', e)
    if (!res.headersSent) sendJson(res, { ok: false, error: String(e.message || e) }, 500)
    else res.destroy()
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ ok: true, url: `http://127.0.0.1:${port}/`, db, root, payloadPath, endpoint, model }))
})
