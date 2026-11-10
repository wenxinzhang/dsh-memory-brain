// topbar.js — 顶栏：品牌、本机连接状态、同步说明、控制面板
import { icons } from '../ui/icons.js'
import { esc } from '../util.js'

export function mount(el, data, handlers = {}) {
  const status = data.status || {}
  const version = status.version || data.version || '0.2.0+12'
  const connected = status.connected !== false
  const readonly = status.readonly !== false

  el.innerHTML = `
    <div class="brand">
      <div class="brand-mark">${icons.brain}</div>
      <div class="brand-text">
        <div class="brand-title">星河大脑</div>
        <div class="brand-sub">MIND GALAXY</div>
      </div>
    </div>
    <div class="top-actions">
      <div class="conn" id="conn">
        <span class="conn-dot${connected ? '' : ' is-off'}"></span>
        <div>
          <div class="conn-title">${status.degraded ? '服务不可用 · 静态回退' : data.source==='sample' ? '合成样例 · 非个人记忆' : connected ? '本机大脑已连接' : '本机大脑未连接'}</div>
          <div class="conn-sub">${readonly ? 'READ ONLY' : 'READ WRITE'} · ${esc(version)}</div>
        </div>
      </div>
      <button class="top-btn" type="button" id="sync-help">
        ${icons.sync}<span>同步说明</span>
      </button>
      <button class="top-btn" type="button" id="open-loop">
        ${icons.brain}<span>闭环</span>
      </button>
      <button class="top-btn" type="button" id="open-rules">
        ${icons.rule}<span>规则</span>
      </button>
      <button class="console-btn" type="button" id="open-console">
        ${icons.sliders}<span>控制面板</span><span class="ext">↗</span>
      </button>
    </div>`

  const syncBtn = el.querySelector('#sync-help')
  const consoleBtn = el.querySelector('#open-console')
  const rulesBtn = el.querySelector('#open-rules')
  const loopBtn = el.querySelector('#open-loop')
  syncBtn.addEventListener('click', (e) => handlers.onSyncHelp?.(syncBtn, e))
  rulesBtn.addEventListener('click', () => handlers.onRules?.())
  loopBtn.addEventListener('click', () => handlers.onLoop?.())
  consoleBtn.addEventListener('click', () => handlers.onConsole?.())

  return {
    setStatus(s) {
      if (!s) return
      if (s.connected != null) el.querySelector('.conn-dot')?.classList.toggle('is-off', !s.connected)
      if (s.connected != null) el.querySelector('.conn-title').textContent = s.degraded ? '服务不可用 · 静态回退' : s.connected ? '本机大脑已连接' : '本机大脑未连接'
      if (s.version) el.querySelector('.conn-sub').textContent = `${s.readonly === false ? 'READ WRITE' : 'READ ONLY'} · ${s.version}`
    },
  }
}
