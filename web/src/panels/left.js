// left.js — 左栏：LOCAL MEMORY CORE / 应用层的记忆 / 功能与管理入口
import { icons } from '../ui/icons.js'
import { esc, fmt, debounce, toneOfKind, toneClass } from '../util.js'

const RANGES = ['最近7天', '最近30天', '最近90天', '全部时间']
const TYPES = ['全部类型', '事实', '推理', '后续/笔记']

export function mount(el, data, handlers = {}) {
  const ov = data.overview || {}
  const loaded = Number(ov.loaded ?? 0)
  const total = Number(ov.total ?? 10887)

  el.innerHTML = `
    <div class="left-scroll">
      <p class="eyebrow">LOCAL MEMORY CORE</p>
      <h1 class="hero">每一段记忆，<br>都能找到来处。</h1>
      <p class="lede">图谱、概念索引与后续状态，<br>在同一颗大脑里清晰呈现。</p>

      <ul class="core-stats">
        <li><span class="stat-label">对话原始</span><span class="stat-value" data-stat="conversationOriginals">${fmt(ov.conversationOriginals)}</span></li>
        <li><span class="stat-label">派生事实索引</span><span class="stat-value" data-stat="derivedFacts">${fmt(ov.derivedFacts)}</span></li>
        <li><span class="stat-label">向量索引</span><span class="stat-value" data-stat="vectorIndex">${fmt(ov.vectorIndex)}</span></li>
      </ul>

      <section class="live">
        <div class="sec-head"><h2>应用层的记忆</h2><span>LIVE MEMORIES</span></div>
        <div class="field-row">
          <label class="field"><span>时间范围</span>
            <span class="select-wrap">
              <select id="f-range" aria-label="时间范围">
                ${RANGES.map((r) => `<option${r === ov.timeRange ? ' selected' : ''}>${r}</option>`).join('')}
              </select>${icons.chevron}
            </span>
          </label>
          <label class="field"><span>记忆类型</span>
            <span class="select-wrap">
              <select id="f-type" aria-label="记忆类型">
                ${TYPES.map((t) => `<option${t === ov.memoryType ? ' selected' : ''}>${t}</option>`).join('')}
              </select>${icons.chevron}
            </span>
          </label>
        </div>

        <form class="search" id="search-form" role="search" autocomplete="off">
          ${icons.search.replace('<svg ', '<svg class="search-icon" ')}
          <input id="search-input" type="search" placeholder="请检索记忆" aria-label="请检索记忆">
          <button class="search-clear" type="button" id="search-clear" hidden aria-label="清除搜索">✕</button>
        </form>
        <div class="search-results" id="search-results" hidden></div>

        <p class="loaded-line">已加载 <b data-loaded>${fmt(loaded)}</b> / <span data-total>${fmt(total)}</span> 条 <span class="dot-sep">·</span> 按时间倒序</p>
        <div class="panel-actions">
          <button class="mini-btn" type="button" data-act="refresh">刷新记忆</button>
          <button class="mini-btn" type="button" data-act="more">加载更多</button>
        </div>
        <ul class="legend">
          <li class="tone-fact"><i></i>事实</li>
          <li class="tone-reasoning"><i></i>推理</li>
          <li class="tone-followup"><i></i>后续/笔记</li>
        </ul>
      </section>

      <section class="entries" id="entries">
        <button class="entries-head" type="button" aria-expanded="true" id="entries-head">
          ${icons.triangle}<span>功能与管理入口</span>
        </button>
        <ul class="entry-list">
          ${(data.functionEntries || []).map((e) => `
            <li class="${toneClass(e.tone)}"><i></i><span class="entry-label">${esc(e.label)}</span><span class="entry-value">${fmt(e.count)}</span></li>
          `).join('')}
        </ul>
      </section>

      <p class="updated">最近更新：<span data-updated>${esc(ov.updatedAt || '—')}</span></p>
    </div>`

  const q = (s) => el.querySelector(s)
  const rangeEl = q('#f-range')
  const typeEl = q('#f-type')
  const searchForm = q('#search-form')
  const searchInput = q('#search-input')
  const searchClear = q('#search-clear')
  const resultsEl = q('#search-results')
  const loadedEl = q('[data-loaded]')
  const totalEl = q('[data-total]')
  const moreBtn = q('[data-act="more"]')
  const refreshBtn = q('[data-act="refresh"]')

  let searchToken = 0

  function fitType() {
    const t = typeEl.value
    const map = { '事实': 'fact', '推理': 'reasoning', '后续/笔记': 'followup' }
    handlers.onFilter?.({ range: rangeEl.value, type: t, tone: map[t] || 'all' })
  }
  rangeEl.addEventListener('change', fitType)
  typeEl.addEventListener('change', fitType)

  const runSearch = debounce(async (raw) => {
    const value = raw.trim()
    searchClear.hidden = !value
    if (!value) {
      resultsEl.hidden = true
      resultsEl.innerHTML = ''
      handlers.onSearchCleared?.()
      return
    }
    const token = ++searchToken
    resultsEl.hidden = false
    resultsEl.innerHTML = '<div class="search-empty">正在检索…</div>'
    handlers.onSearching?.(true)
    try {
      const res = await handlers.onSearch?.(value)
      if (token !== searchToken) return
      renderResults(res, value)
    } catch (e) {
      if (token === searchToken) resultsEl.innerHTML = `<div class="search-empty">检索失败：${esc(e.message || e)}</div>`
    } finally {
      if (token === searchToken) handlers.onSearching?.(false)
    }
  }, 200)

  function renderResults(res, qstr) {
    const items = (res && res.items) || []
    if (!items.length) {
      resultsEl.innerHTML = `<div class="search-empty">没有找到「${esc(qstr)}」相关的记忆</div>`
      return
    }
    resultsEl.innerHTML = items.slice(0, 8).map((it) => {
      const tone = it.tone || (it.type === 'node' ? 'reasoning' : toneOfKind(it.kind))
      const text = it.text || it.name || ''
      return `<button class="search-hit ${toneClass(tone)}" type="button" data-id="${esc(it.id)}">
        <i></i><span>${esc(text)}</span></button>`
    }).join('')
  }

  searchForm.addEventListener('submit', (e) => {
    e.preventDefault()
    runSearch(searchInput.value)
  })
  searchInput.addEventListener('input', () => runSearch(searchInput.value))
  searchClear.addEventListener('click', () => {
    searchInput.value = ''
    runSearch('')
    resultsEl.hidden = true
    handlers.onSearchCleared?.()
    searchInput.focus()
  })
  resultsEl.addEventListener('click', (e) => {
    const hit = e.target.closest('.search-hit')
    if (!hit) return
    handlers.onSelectMemory?.({ id: hit.dataset.id })
  })

  q('#entries-head').addEventListener('click', () => {
    const sec = q('#entries')
    const collapsed = sec.classList.toggle('is-collapsed')
    q('#entries-head').setAttribute('aria-expanded', String(!collapsed))
  })

  refreshBtn.addEventListener('click', async () => {
    if (refreshBtn.disabled) return
    refreshBtn.disabled = true
    refreshBtn.textContent = '刷新中…'
    try {
      await handlers.onRefresh?.()
    } finally {
      refreshBtn.disabled = false
      refreshBtn.textContent = '刷新记忆'
    }
  })

  moreBtn.addEventListener('click', async () => {
    const res = await handlers.onLoadMore?.()
    if (!res) return
    loadedEl.textContent = fmt(res.loaded)
    totalEl.textContent = fmt(res.total)
    moreBtn.disabled = res.loaded >= res.total
    if (res.loaded >= res.total) moreBtn.textContent = '已全部加载'
  })

  // 初次渲染时如果已加载满，按钮置灰
  if (loaded >= total) {
    moreBtn.disabled = true
    moreBtn.textContent = '已全部加载'
  }

  return {
    setOverview(next) {
      if (!next) return
      for (const k of ['conversationOriginals', 'derivedFacts', 'vectorIndex']) {
        const node = q(`[data-stat="${k}"]`)
        if (node && next[k] != null) node.textContent = fmt(next[k])
      }
      if (next.updatedAt) q('[data-updated]').textContent = next.updatedAt
      if (next.total != null) totalEl.textContent = fmt(next.total)
    },
    setLoaded(n) { loadedEl.textContent = fmt(n) },
    setUpdated(str) { if (str) q('[data-updated]').textContent = str },
    setSearching(on) { searchForm.classList.toggle('is-searching', !!on) },
    setSearchResults(res, qstr) {
      resultsEl.hidden = !qstr
      if (qstr) renderResults(res, qstr)
    },
    focusSearch() { searchInput.focus() },
    clearSearch() {
      searchInput.value = ''
      resultsEl.hidden = true
      resultsEl.innerHTML = ''
      searchClear.hidden = true
    },
  }
}
