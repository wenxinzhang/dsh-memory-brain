// overlays.js — 抽屉、同步说明气泡、模态、toast、锁屏
import { icons } from './icons.js'
import { esc } from '../util.js'

const root = () => document.getElementById('overlay-root')

let activeCleanup = null

function cleanup() {
  const fn = activeCleanup
  activeCleanup = null
  if (fn) fn()
  const host = root()
  if (host) host.innerHTML = ''
  document.body.classList.remove('overlay-open')
}

export function closeOverlay() { cleanup() }

/* ------------------------------------------------------------ toast */
export function toast(message, ms = 2200) {
  const host = document.getElementById('toast-root')
  const node = document.createElement('div')
  node.className = 'toast'
  node.innerHTML = `<i></i><span>${esc(message)}</span>`
  host.appendChild(node)
  setTimeout(() => {
    node.style.transition = 'opacity .2s, transform .2s'
    node.style.opacity = '0'
    node.style.transform = 'translateY(-4px)'
    setTimeout(() => node.remove(), 220)
  }, ms)
}

/* ------------------------------------------------------------ sync popover */
export function openSyncPopover(anchor, data = {}) {
  document.querySelector('.popover')?.remove()
  const rect = anchor.getBoundingClientRect()
  const pop = document.createElement('div')
  pop.className = 'popover'
  pop.innerHTML = `
    <h4>本机大脑 · 只读连接</h4>
    <p>记忆只在本机登记、索引和检索；页面不会上传对话原文、位置或敏感内容。</p>
    <div class="pop-list">
      <span><i></i>对话原始与派生索引同源</span>
      <span><i></i>${esc(data.version || '0.2.0+12')} · READ ONLY</span>
      <span><i></i>最近同步 ${esc(data.updatedAt || '—')}</span>
    </div>`
  const left = Math.min(window.innerWidth - 316, Math.max(12, rect.right - 300))
  const top = Math.min(window.innerHeight - 200, rect.bottom + 10)
  pop.style.left = `${left}px`
  pop.style.top = `${top}px`
  root().appendChild(pop)
  const onDoc = (e) => {
    if (pop.contains(e.target) || anchor.contains(e.target)) return
    pop.remove()
    document.removeEventListener('pointerdown', onDoc, true)
  }
  document.addEventListener('pointerdown', onDoc, true)
}

/* ------------------------------------------------------------ settings drawer */
export function openSettings({ data = {}, settings = {}, onChange = () => {}, onReset = () => {} } = {}) {
  cleanup()
  document.body.classList.add('overlay-open')
  const s = { flow: true, spin: true, orbit: false, glow: 60, density: 36, bloom: 85, ...settings }

  const wrap = document.createElement('div')
  wrap.innerHTML = `
    <div class="scrim" data-close></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="视觉设置">
      <div class="drawer-head">
        <div>
          <div class="drawer-title">视觉设置</div>
          <div class="drawer-sub">VISUAL CONTROLS · 本机渲染</div>
        </div>
        <button class="drawer-close" type="button" data-close aria-label="关闭">✕</button>
      </div>
      <div class="drawer-body">
        <section class="drawer-section">
          <h3>视图</h3>
          <div class="setting-row">
            <div><div class="sr-label">流动动画</div><div class="sr-hint">光纤与节点的呼吸脉冲</div></div>
            <button class="switch ${s.flow ? 'is-on' : ''}" type="button" role="switch" aria-checked="${s.flow}" data-sw="flow"><span></span></button>
          </div>
          <div class="setting-row">
            <div><div class="sr-label">自动旋转</div><div class="sr-hint">画面缓慢环绕，便于观察整体</div></div>
            <button class="switch ${s.spin ? 'is-on' : ''}" type="button" role="switch" aria-checked="${s.spin}" data-sw="spin"><span></span></button>
          </div>
          <div class="setting-row">
            <div><div class="sr-label">拖拽视角</div><div class="sr-hint">允许用鼠标拖动旋转与缩放</div></div>
            <button class="switch ${s.orbit ? 'is-on' : ''}" type="button" role="switch" aria-checked="${s.orbit}" data-sw="orbit"><span></span></button>
          </div>
        </section>

        <section class="drawer-section">
          <h3>渲染</h3>
          <div class="setting-col">
            <div class="sc-top"><span class="sc-label">光晕强度</span><span class="sc-value" data-out="glow">${s.glow}</span></div>
            <input type="range" min="0" max="100" step="1" value="${s.glow}" data-range="glow" aria-label="光晕强度">
          </div>
          <div class="setting-col">
            <div class="sc-top"><span class="sc-label">光纤密度</span><span class="sc-value" data-out="density">${s.density}</span></div>
            <input type="range" min="0" max="100" step="1" value="${s.density}" data-range="density" aria-label="光纤密度">
          </div>
          <div class="setting-col">
            <div class="sc-top"><span class="sc-label">泛光阈值</span><span class="sc-value" data-out="bloom">${s.bloom}</span></div>
            <input type="range" min="0" max="100" step="1" value="${s.bloom}" data-range="bloom" aria-label="泛光阈值">
          </div>
        </section>

        <section class="drawer-section">
          <h3>数据源</h3>
          <div class="setting-row"><span class="sr-label">来源</span><span class="sr-value">${esc(data.source === 'db' ? '本机记忆库' : '演示数据')}</span></div>
          <div class="setting-row"><span class="sr-label">版本</span><span class="sr-value">${esc(data.version || '0.2.0+12')}</span></div>
          <div class="setting-row"><span class="sr-label">记忆总量</span><span class="sr-value">${esc(String((data.overview && data.overview.total) || 0))}</span></div>
          <div class="setting-row"><span class="sr-label">最近更新</span><span class="sr-value">${esc((data.overview && data.overview.updatedAt) || '—')}</span></div>
        </section>

        <section class="drawer-section">
          <button class="mini-btn" type="button" data-reset>恢复默认视觉</button>
        </section>
      </div>
      <div class="drawer-foot">
        <b>记忆只在本机处理。</b>页面不会上传对话原文、位置信息或敏感内容。<br>
        本面板为只读视图，所有写入由记忆服务箱机在后台完成。
      </div>
    </aside>`
  root().appendChild(wrap)

  const drawer = wrap.querySelector('.drawer')
  const close = () => cleanup()
  wrap.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', close))
  drawer.addEventListener('pointerdown', (e) => e.stopPropagation())
  const onKey = (e) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  activeCleanup = () => document.removeEventListener('keydown', onKey)

  function applySwitch(key, on) {
    const b = drawer.querySelector(`[data-sw="${key}"]`)
    b.classList.toggle('is-on', on)
    b.setAttribute('aria-checked', String(on))
    s[key] = on
    onChange(key, on)
  }

  drawer.querySelectorAll('[data-sw]').forEach((b) => {
    b.addEventListener('click', () => applySwitch(b.dataset.sw, !b.classList.contains('is-on')))
  })

  const rangeMap = { glow: 100, density: 100, bloom: 100 }
  drawer.querySelectorAll('[data-range]').forEach((input) => {
    const key = input.dataset.range
    const out = drawer.querySelector(`[data-out="${key}"]`)
    const paint = () => {
      input.style.setProperty('--fill', `${(Number(input.value) / rangeMap[key]) * 100}%`)
      out.textContent = input.value
    }
    paint()
    input.addEventListener('input', () => {
      paint()
      s[key] = Number(input.value)
      onChange(key, s[key])
    })
  })

  drawer.querySelector('[data-reset]').addEventListener('click', () => {
    s.flow = true; s.spin = true; s.orbit = false; s.glow = 60; s.density = 36; s.bloom = 85
    drawer.querySelectorAll('[data-sw]').forEach((b) => {
      const on = s[b.dataset.sw]
      b.classList.toggle('is-on', !!on)
      b.setAttribute('aria-checked', String(!!on))
    })
    drawer.querySelectorAll('[data-range]').forEach((input) => {
      const key = input.dataset.range
      input.value = s[key]
      input.style.setProperty('--fill', `${(Number(input.value) / rangeMap[key]) * 100}%`)
      drawer.querySelector(`[data-out="${key}"]`).textContent = input.value
    })
    onReset(s)
  })
}

/* ------------------------------------------------------------ generic modal */
export function openModal({ title, paragraphs = [], actions = [] } = {}) {
  cleanup()
  document.body.classList.add('overlay-open')
  const wrap = document.createElement('div')
  wrap.className = 'modal'
  wrap.innerHTML = `
    <div class="scrim" data-close></div>
    <div class="modal-card" role="dialog" aria-modal="true">
      <h2>${esc(title || '')}</h2>
      ${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}
      <div class="modal-actions">
        ${actions.map((a, i) => `<button class="modal-btn${a.primary ? ' primary' : ''}" type="button" data-i="${i}">${esc(a.label)}</button>`).join('')}
      </div>
    </div>`
  root().appendChild(wrap)
  const close = () => cleanup()
  wrap.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', close))
  wrap.querySelectorAll('[data-i]').forEach((b) => {
    b.addEventListener('click', () => {
      const action = actions[Number(b.dataset.i)]
      close()
      action?.onClick?.()
    })
  })
  const onKey = (e) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  activeCleanup = () => document.removeEventListener('keydown', onKey)
}

/* ------------------------------------------------------------ lock screen */
export function openLock(onUnlock) {
  cleanup()
  document.body.classList.add('overlay-open')
  const wrap = document.createElement('div')
  wrap.className = 'lock-screen'
  wrap.innerHTML = `
    <div class="lock-card">
      <div class="lock-icon">${icons.lock}</div>
      <h2>忆核大脑已锁定</h2>
      <p>记忆仍在本地运行，解锁后继续查看。</p>
      <button type="button" data-unlock>解锁并继续</button>
    </div>`
  root().appendChild(wrap)
  const close = () => cleanup()
  wrap.querySelector('[data-unlock]').addEventListener('click', () => { close(); onUnlock?.() })
  const onKey = (e) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  activeCleanup = () => document.removeEventListener('keydown', onKey)
}
