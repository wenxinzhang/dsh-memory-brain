// rules.js — 规则提炼抽屉：候选规则确认 / 已入库规则
import { esc, fmt } from '../util.js'
import { toast } from './overlays.js'
import {
  getRules, getRulesStatus, getRulesSources, extractRules, approveRule, rejectRule, deleteRule,
} from '../api.js'

const TYPE_LABEL = { preference: '偏好', boundary: '边界', workflow: '流程', principle: '原则' }
const STATE_LABEL = { idle: '空闲', running: '提炼中', done: '已完成', error: '失败' }

function pct(v) {
  return `${Math.round((Number(v) || 0) * 100)}%`
}

export function openRules() {
  const host = document.getElementById('overlay-root')
  if (!host) return
  closeExisting()
  document.body.classList.add('overlay-open')

  host.innerHTML = `
    <div class="scrim" data-close></div>
    <aside class="rules-drawer" role="dialog" aria-modal="true" aria-label="规则提炼">
      <div class="rules-head">
        <div>
          <div class="rules-title">规则提炼</div>
          <div class="rules-sub">RULE EXTRACTION · 本地语料 → 人工确认 → 规则库</div>
        </div>
        <button class="drawer-close" type="button" data-close aria-label="关闭">✕</button>
      </div>
      <div class="rules-body" id="rules-body"></div>
      <div class="rules-foot">
        抽取使用已配置的模型端点；远程端点会接收选中的语料。
        「采纳」后进入闭环规则中心的候选，补齐条件与动作并审核后生效。
      </div>
    </aside>`

  const body = host.querySelector('#rules-body')
  const drawer = host.querySelector('.rules-drawer')
  let data = null
  let status = null
  let sourcesInfo = null
  let tab = 'candidates'
  let pollTimer = 0
  let closed = false

  function closeExisting() {
    // overlays.js 的 cleanup 会把 overlay-root 清空；这里手动处理同类结构
    const root = document.getElementById('overlay-root')
    root?.__memoryBrainClose?.()
    if (root) root.innerHTML = ''
    document.body.classList.remove('overlay-open')
  }

  function close() {
    if (closed) return
    closed = true
    host.__memoryBrainClose = null
    if (pollTimer) clearInterval(pollTimer)
    document.removeEventListener('keydown', onKey)
    closeExisting()
  }

  function onKey(e) {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)
  host.__memoryBrainClose = close

  function errorPage(message) {
    body.innerHTML = `
      <div class="rules-empty rules-error">
        <div class="rules-empty-title">规则接口不可用</div>
        <p>${esc(message)}</p>
        <p class="rules-hint">如果是刚升级插件，重启一次 DSH 后 host 半边才会加载新的 <code>/api/rules</code> 接口。</p>
        <button class="rules-btn" type="button" data-action="reload">重试</button>
      </div>`
  }

  function statusBlock() {
    if (!status) return ''
    const running = status.state === 'running'
    const total = Number(status.progress?.total) || 0
    const done = Number(status.progress?.done) || 0
    const percent = total ? Math.round((done / total) * 100) : 0
    return `
      <div class="rules-status ${running ? 'is-running' : ''} ${status.state === 'error' ? 'is-error' : ''}">
        <div class="rules-status-top">
          <span class="rules-status-dot"></span>
          <span class="rules-status-label">${esc(STATE_LABEL[status.state] || status.state)}</span>
          <span class="rules-status-msg">${esc(status.message || '')}</span>
          ${status.state === 'running' ? `<span class="rules-status-num">${done}/${total || '?'}</span>` : ''}
        </div>
        ${running ? `<div class="rules-progress"><i style="width:${percent}%"></i></div>` : ''}
        ${status.error ? `<div class="rules-status-error">${esc(status.error)}</div>` : ''}
      </div>`
  }

  function candidateCard(r) {
    const type = r.type || 'principle'
    return `<article class="rule-card rule-${esc(type)}">
      <div class="rule-meta">
        <span class="rule-type">${esc(r.typeLabel || TYPE_LABEL[type] || type)}</span>
        <span class="rule-conf">置信度 ${pct(r.confidence)}</span>
      </div>
      <div class="rule-line rule-if"><span class="rule-tag">当</span><span>${esc(r.condition || '（无特定触发条件）')}</span></div>
      <div class="rule-line rule-then"><span class="rule-tag">则</span><span>${esc(r.action)}</span></div>
      ${r.evidence?.quote ? `<div class="rule-evidence">“${esc(r.evidence.quote)}”<span>— ${esc(r.evidence.source || '语料')}</span></div>` : ''}
      <div class="rule-actions">
        <button class="rule-btn rule-approve" type="button" data-approve="${esc(r.id)}">采纳</button>
        <button class="rule-btn rule-reject" type="button" data-reject="${esc(r.id)}">忽略</button>
      </div>
    </article>`
  }

  function approvedCard(r) {
    const type = r.type || 'principle'
    return `<article class="rule-card rule-${esc(type)}">
      <div class="rule-meta">
        <span class="rule-type">${esc(r.typeLabel || TYPE_LABEL[type] || type)}</span>
        <span class="rule-conf">已入库${r.approvedAt ? ' · ' + esc(String(r.approvedAt).slice(0, 10)) : ''}</span>
      </div>
      <div class="rule-line rule-if"><span class="rule-tag">当</span><span>${esc(r.condition || '（无特定触发条件）')}</span></div>
      <div class="rule-line rule-then"><span class="rule-tag">则</span><span>${esc(r.action)}</span></div>
      ${r.evidence?.quote ? `<div class="rule-evidence">“${esc(r.evidence.quote)}”<span>— ${esc(r.evidence.source || '语料')}</span></div>` : ''}
      <div class="rule-actions">
        <button class="rule-btn rule-delete" type="button" data-delete="${esc(r.id)}">删除</button>
      </div>
    </article>`
  }

  function render() {
    if (!data) return
    const corpus = data.corpus || {}
    const candidates = Array.isArray(data.candidates) ? data.candidates : []
    const rules = Array.isArray(data.rules) ? data.rules : []
    const running = status?.state === 'running'
    const current = tab === 'candidates' ? candidates : rules

    body.innerHTML = `
      <div class="rules-stats">
        <div class="rules-stat"><span>语料文件</span><b>${fmt(corpus.files)}</b></div>
        <div class="rules-stat"><span>语料字符</span><b>${fmt(corpus.chars)}</b></div>
        <div class="rules-stat"><span>送检分块</span><b>${fmt(corpus.chunks)}</b></div>
        <div class="rules-stat"><span>候选 / 规则</span><b>${candidates.length} / ${rules.length}</b></div>
      </div>
      <div class="rules-corpus-line">
        <span>${esc(data.model || '未提炼')} · ${esc(corpus.truncated ? '语料超出本次上限，已截断' : '全量扫描')}</span>
        <span>${corpus.scannedAt ? '最近扫描 ' + esc(String(corpus.scannedAt).replace('T', ' ').slice(0, 19)) : '尚未扫描'}</span>
      </div>
      <div class="rules-sources">
        <label><input type="checkbox" data-source="corpus" checked> corpus/ 文件</label>
        <label><input type="checkbox" data-source="docs" checked> 工作区 MD</label>
        <label><input type="checkbox" data-source="sessions" checked> DSH 对话</label>
        <span class="rules-workspace">${esc(sourcesInfo?.current?.title || sourcesInfo?.workspaces?.[0]?.title || '当前工作区')}</span>
      </div>
      ${statusBlock()}
      <div class="rules-actions">
        <button class="rules-btn rules-btn-primary" type="button" data-action="extract" ${running ? 'disabled' : ''}>
          ${running ? '正在提炼…' : '扫描并提炼'}
        </button>
        <button class="rules-btn" type="button" data-action="reload">刷新</button>
        <span class="rules-hint-inline">来源：corpus / 工作区 MD / DSH 对话</span>
      </div>
      <nav class="rules-tabs" role="tablist">
        <button class="rules-tab ${tab === 'candidates' ? 'is-active' : ''}" type="button" data-tab="candidates">候选规则 <b>${candidates.length}</b></button>
        <button class="rules-tab ${tab === 'rules' ? 'is-active' : ''}" type="button" data-tab="rules">已入库 <b>${rules.length}</b></button>
      </nav>
      <div class="rules-list">
        ${current.length
          ? current.map((r) => (tab === 'candidates' ? candidateCard(r) : approvedCard(r))).join('')
          : `<div class="rules-empty">${tab === 'candidates'
              ? '还没有候选规则。选择语料来源后点「扫描并提炼」。'
              : '还没有已采纳的规则。候选规则点「采纳」后会出现在这里。'}</div>`}
      </div>`

    body.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', close))
  }

  async function load() {
    try {
      const next = await getRules()
      if (closed) return
      data = next
      status = next.status || null
      getRulesSources().then((info) => {
        if (closed) return
        sourcesInfo = info
        render()
      }).catch(() => {})
      render()
      if (status?.state === 'running') beginPoll()
    } catch (e) {
      if (!closed) errorPage(e.message || String(e))
    }
  }

  function beginPoll() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(async () => {
      if (closed) return
      try {
        const st = await getRulesStatus()
        if (closed) return
        status = st
        if (st.state === 'running') render()
        else {
          clearInterval(pollTimer)
          pollTimer = 0
          await load()
          if (st.state === 'done') toast(st.message || '规则提炼完成')
          if (st.state === 'error') toast('提炼失败：' + (st.error || '未知错误'), 3200)
        }
      } catch {
        /* 轮询失败静默，下一轮再试 */
      }
    }, 1500)
  }

  async function runAction(fn) {
    try {
      const next = await fn()
      data = next
      status = next.status || status
      if (next.status) status = next.status
      render()
    } catch (e) {
      toast(e.message || String(e), 3200)
    }
  }

  drawer.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return close()
    const tabBtn = e.target.closest('[data-tab]')
    if (tabBtn) {
      tab = tabBtn.dataset.tab
      render()
      return
    }
    const action = e.target.closest('[data-action]')
    if (action) {
      const act = action.dataset.action
      if (act === 'reload') return load()
      if (act === 'extract') {
        if (status?.state === 'running') return
        const inputs = [...body.querySelectorAll('[data-source]')]
        const sources = {}
        for (const input of inputs) sources[input.dataset.source] = input.checked
        if (!Object.values(sources).some(Boolean)) return toast('至少选择一个语料来源', 2400)
        try {
          await extractRules({ sources })
          status = await getRulesStatus()
          render()
          beginPoll()
          toast('已开始提炼，语料较多时需要几分钟')
        } catch (err) {
          toast(err.message || String(err), 3200)
        }
        return
      }
    }
    const approve = e.target.closest('[data-approve]')
    if (approve) return runAction(() => approveRule(approve.dataset.approve))
    const reject = e.target.closest('[data-reject]')
    if (reject) return runAction(() => rejectRule(reject.dataset.reject))
    const del = e.target.closest('[data-delete]')
    if (del) return runAction(() => deleteRule(del.dataset.delete))
  })

  load()
}
