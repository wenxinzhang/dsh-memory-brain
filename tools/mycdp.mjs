#!/usr/bin/env node
/**
 * tools/mycdp.mjs — minimal CDP driver (no npm deps) used by the design tools.
 * Same shape as web/tools/cdp.mjs but launches Chrome with --no-sandbox so it
 * works under this sandboxed session, and exposes screenshot/full-page capture.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p))

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function launch({ width = 1440, height = 900, dpr = 1 } = {}) {
  if (!CHROME) throw new Error('no chrome binary')
  const profile = join(tmpdir(), `dsh-design-${Date.now()}-${process.pid}`)
  mkdirSync(profile, { recursive: true })
  const port = 9600 + Math.floor(Math.random() * 300)
  const proc = spawn(CHROME, [
    '--no-sandbox', '--disable-breakpad', '--disable-crash-reporter',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--mute-audio',
    '--disable-lcd-text', '--force-color-profile=srgb',
    '--font-render-hinting=none',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' })

  const cleanup = () => {
    try { proc.kill('SIGKILL') } catch {}
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  }

  let wsUrl = null
  for (let i = 0; i < 120 && !wsUrl; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      wsUrl = j.webSocketDebuggerUrl
    } catch {}
    if (!wsUrl) await sleep(200)
  }
  if (!wsUrl) { cleanup(); throw new Error('CDP endpoint never came up') }

  const sock = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    sock.addEventListener('open', res, { once: true })
    sock.addEventListener('error', () => rej(new Error('ws error')), { once: true })
  })

  let seq = 0
  const pending = new Map()
  const logs = []
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      logs.push('[EXCEPTION] ' + (d.exception?.description || d.text))
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = (m.params.args || []).map((x) => x.value ?? x.description ?? '').join(' ')
      logs.push(`[console.${m.params.type}] ${a}`)
    }
    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry
      logs.push(`[log.${e.level}] ${e.text}${e.url ? ' @' + e.url : ''}`)
    }
    if (m.method === 'Page.javascriptDialogOpening') { logs.push('[dialog] ' + m.params.message) }
    if (m.method === 'Page.loadEventFired') { logs.push('[load] ' + m.params.timestamp) }
  })

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      sock.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }))
    })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Runtime.enable', {}, sessionId)
  await send('Log.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: dpr, mobile: false }, sessionId)

  return {
    sessionId,
    logs,
    send: (m, p) => send(m, p, sessionId),
    async evaluate(expression) {
      const r = await send('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true }, sessionId)
      if (r.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.exceptionDetails))
      return r.result.value
    },
    async navigate(url, waitMs = 1200) {
      await send('Page.navigate', { url })
      await sleep(waitMs)
    },
    async screenshot(path, { fullPage = false } = {}) {
      const params = { format: 'png' }
      if (fullPage) {
        const m = await send('Page.getLayoutMetrics')
        const cs = m.cssContentSize || m.contentSize
        params.clip = { x: 0, y: 0, width: Math.ceil(cs.width), height: Math.ceil(cs.height), scale: 1 }
        params.captureBeyondViewport = true
      }
      const shot = await send('Page.captureScreenshot', params)
      writeFileSync(path, Buffer.from(shot.data, 'base64'))
      return path
    },
    setViewport(w, h, d = 1) {
      return send('Emulation.setDeviceMetricsOverride',
        { width: w, height: h, deviceScaleFactor: d, mobile: false }, sessionId)
    },
    close() { try { sock.close() } catch {}; cleanup() },
  }
}
