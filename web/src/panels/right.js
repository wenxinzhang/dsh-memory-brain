// right.js — 右栏：记忆运行状态
import { icons } from '../ui/icons.js'
import { esc, fmt } from '../util.js'

export function mount(el, data, handlers = {}) {
  const rt = data.runtime || {}
  const ov = data.overview || {}
  const tabs = Array.isArray(rt.tabs) && rt.tabs.length ? rt.tabs : [{ key: 'run', label: '运行', rows: [] }]
  const active = tabs[0].key
  const loaded = Number(rt.loaded ?? ov.loaded ?? 0)
  const total = Number(rt.total ?? ov.total ?? 0)

  el.innerHTML = `
    <div class="right-scroll">
      <h2 class="rt-title">${esc(rt.title || '记忆运行状态')}</h2>
      <div class="rt-big"><b data-big>${fmt(loaded)}</b><span>/ <em data-big-total>${fmt(total)}</em> 条已加载</span></div>

      <p class="rt-para">${(rt.paragraphs || []).map((p) => esc(p)).join('<br>')}</p>
      <p class="rt-note">${esc(rt.note || '')}</p>

      <button class="rt-link" type="button" id="rt-console">
        <span>${esc(rt.controlLabel || '在控制面板查看')}</span>${icons.external}
      </button>

      <div class="engine-row">
        <span class="dot"></span>
        <b>${esc(rt.engine?.label || '工程快照')}</b>
        <span>${esc(rt.engine?.name || '')}</span>
      </div>
      <p class="engine-desc">${(rt.engine?.desc || []).map((p) => esc(p)).join('<br>')}</p>

      <nav class="rt-tabs" role="tablist" aria-label="运行状态视图">
        ${tabs.map((t) => `<button class="rt-tab${t.key === active ? ' is-active' : ''}" role="tab" type="button"
            data-tab="${esc(t.key)}" aria-selected="${t.key === active}">${esc(t.label)}</button>`).join('')}
      </nav>

      <section class="chain" id="chain">
        <div class="chain-head"><span data-chain-title>${esc(tabs[0].channelTitle || '原始到检索的链路')}</span>${icons.waveform}</div>
        <ul class="chain-rows" data-rows></ul>
      </section>
    </div>`

  const q = (s) => el.querySelector(s)
  const rowsEl = q('[data-rows]')
  const chainEl = q('#chain')
  let current = active

  function renderRows(tab) {
    const rows = tab.rows || []
    rowsEl.innerHTML = rows.map((r) => {
      const cls = ['row-value']
      if (r.state === 'warn') cls.push('is-warn')
      if (r.mono) cls.push('mono')
      return `<li><span class="row-label">${esc(r.label)}</span><span class="${cls.join(' ')}">${esc(r.value)}</span></li>`
    }).join('')
    q('[data-chain-title]').textContent = tab.channelTitle || tab.label || ''
  }

  function selectTab(key) {
    const tab = tabs.find((t) => t.key === key) || tabs[0]
    current = tab.key
    el.querySelectorAll('.rt-tab').forEach((b) => {
      const on = b.dataset.tab === tab.key
      b.classList.toggle('is-active', on)
      b.setAttribute('aria-selected', String(on))
    })
    renderRows(tab)
    chainEl.classList.remove('rt-fade')
    void chainEl.offsetWidth
    chainEl.classList.add('rt-fade')
    handlers.onTab?.(tab.key)
  }

  el.querySelectorAll('.rt-tab').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)))
  q('#rt-console').addEventListener('click', () => handlers.onConsole?.())
  renderRows(tabs[0])

  return {
    selectTab,
    setLoaded(n, t) {
      if (n != null) q('[data-big]').textContent = fmt(n)
      if (t != null) q('[data-big-total]').textContent = fmt(t)
    },
    getTab: () => current,
  }
}
