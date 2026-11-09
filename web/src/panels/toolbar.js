// toolbar.js — 底栏：流动/自转/视角/重置/视觉设置/完整/最新状态/退出登录
import { icons } from '../ui/icons.js'

export function mount(el, data, handlers = {}) {
  el.innerHTML = `
    <div class="bottom-center" role="toolbar" aria-label="视图与系统操作">
      <button class="tb-btn pill" type="button" data-act="flow">暂停流动</button>
      <button class="tb-btn pill" type="button" data-act="spin">暂停自转</button>
      <button class="tb-btn ghost" type="button" data-act="orbit">${icons.orbit}<span>转动视角</span></button>
      <button class="tb-btn ghost" type="button" data-act="reset">${icons.reset}<span>重置</span></button>
      <span class="tb-sep"></span>
      <button class="tb-btn ghost" type="button" data-act="settings">${icons.settings}<span>视觉设置</span></button>
      <button class="tb-btn ghost" type="button" data-act="full">${icons.fullscreen}<span>完整</span></button>
      <span class="tb-sep"></span>
      <button class="tb-btn ghost" type="button" data-act="refresh">${icons.activity}<span>最新状态</span></button>
      <button class="tb-btn ghost" type="button" data-act="logout">${icons.logout}<span>退出登录</span></button>
    </div>
    <div class="bottom-note">${(data.footer && data.footer.note) || '无位置隐私记录、敏感内容，完全为本地系统。'}</div>`

  const btn = (act) => el.querySelector(`[data-act="${act}"]`)
  let flow = true
  let spin = true
  let orbit = false

  function paintFlow() {
    const b = btn('flow')
    b.textContent = flow ? '暂停流动' : '继续流动'
    b.classList.toggle('is-on', !flow)
    b.setAttribute('aria-pressed', String(!flow))
  }
  function paintSpin() {
    const b = btn('spin')
    b.textContent = spin ? '暂停自转' : '继续自转'
    b.classList.toggle('is-on', !spin)
    b.setAttribute('aria-pressed', String(!spin))
  }
  function paintOrbit() {
    btn('orbit').classList.toggle('is-on', orbit)
    btn('orbit').setAttribute('aria-pressed', String(orbit))
  }

  btn('flow').addEventListener('click', () => {
    flow = !flow
    paintFlow()
    handlers.onFlow?.(flow)
  })
  btn('spin').addEventListener('click', () => {
    spin = !spin
    paintSpin()
    handlers.onSpin?.(spin)
  })
  btn('orbit').addEventListener('click', () => {
    orbit = !orbit
    paintOrbit()
    handlers.onOrbit?.(orbit)
  })
  btn('reset').addEventListener('click', () => {
    handlers.onReset?.()
    flash(btn('reset'))
  })
  btn('settings').addEventListener('click', () => handlers.onSettings?.())
  btn('full').addEventListener('click', () => handlers.onFullscreen?.())
  btn('refresh').addEventListener('click', async () => {
    const b = btn('refresh')
    if (b.classList.contains('is-busy')) return
    b.classList.add('is-busy')
    b.style.opacity = '0.6'
    try { await handlers.onRefresh?.() } finally {
      b.classList.remove('is-busy')
      b.style.opacity = ''
    }
  })
  btn('logout').addEventListener('click', () => handlers.onLogout?.())

  function flash(node) {
    node.classList.remove('is-on')
    void node.offsetWidth
    node.classList.add('is-on')
    setTimeout(() => {
      if (node.dataset.act !== 'orbit' || !orbit) node.classList.remove('is-on')
    }, 300)
  }

  paintFlow()
  paintSpin()
  paintOrbit()

  return {
    setFlow(on) { flow = on !== false; paintFlow() },
    setSpin(on) { spin = on !== false; paintSpin() },
    setOrbit(on) { orbit = on === true; paintOrbit() },
    isFlow: () => flow,
    isSpin: () => spin,
    isOrbit: () => orbit,
  }
}
