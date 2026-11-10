// app.js — 启动与装配
// 页面结构：顶栏 / 左栏 / 中间 3D 舞台 / 右栏 / 底栏 + 浮层
import { loadAll, search, getNode, clearCache } from './api.js'
import { mount as mountTopbar } from './panels/topbar.js'
import { mount as mountLeft } from './panels/left.js'
import { mount as mountRight } from './panels/right.js'
import { mount as mountToolbar } from './panels/toolbar.js'
import { mountBrain } from './brain/mount.js'
import { toast, openSyncPopover, openSettings, openLock } from './ui/overlays.js'
import { openRules } from './ui/rules.js'
import { openLoop } from './ui/loop.js'
import { esc, fmt, relTime, toneOfKind, toneClass } from './util.js'
import { icons } from './ui/icons.js'
import { selectMemoryWindow } from './memory-view.js'

const stage = document.getElementById('stage')
const canvas = document.getElementById('cortex-canvas')
const loading = document.getElementById('model-loading')
const bootError = document.getElementById('boot-error')
const nodeCard = document.getElementById('node-card')

const params = new URLSearchParams(location.search)
const still = params.get('still') === '1'
const num = (key, fallback) => (params.get(key) == null || params.get(key) === '' ? fallback : Number(params.get(key)))

const state = {
  data: null,
  loaded: 0,
  total: 0,
  filter: { range: '最近30天', type: '全部类型', tone: 'all' },
  settings: {
    flow: !still,
    spin: !still,
    orbit: false,
    glow: 60,
    density: 36,
    bloom: 85,
  },
  brain: null,
  panels: {},
  windowLimit: 200,
  graphMode: 'base',
}

let topbar, left, right, toolbar
let panelHandlers

function mountPanels(data,handlers) {
  const previousTab=right?.getTab?.()
  topbar=mountTopbar(document.getElementById('topbar'),data,handlers)
  left=mountLeft(document.getElementById('panel-left'),data,handlers)
  right=mountRight(document.getElementById('panel-right'),data,handlers)
  toolbar=mountToolbar(document.getElementById('bottombar'),data,handlers)
  if(previousTab) right?.selectTab?.(previousTab)
  state.panels={topbar,left,right,toolbar};window.__PANELS=state.panels
}

/* ------------------------------------------------------------ 错误 */
function fail(err) {
  console.error(err)
  bootError.hidden = false
  bootError.textContent = `记忆页面加载失败：${err && err.message ? err.message : err}`
  loading?.classList.add('is-hidden')
}

function setLoading(on, text) {
  if (!loading) return
  loading.classList.toggle('is-hidden', !on)
  if (text) {
    const t = loading.querySelector('.ml-text')
    if (t) t.textContent = text
  }
}

/* ------------------------------------------------------------ 节点卡片 */
function hideNodeCard() {
  nodeCard.hidden = true
  nodeCard.innerHTML = ''
  state.brain?.select?.(null)
}

function showNodeCard(node, detail) {
  if (!node && !detail) return hideNodeCard()
  const d = detail || {}
  const name = d.name || d.text || node?.label || node?.name || '未命名记忆'
  const kind = d.kind || d.type || node?.kind || node?.category || 'memory'
  const kindLabel = {
    fact: '事实记忆', reflection: '推理记忆', episode: '经历记忆', skill: '技能记忆',
    review: '回顾记忆', self: '自我记忆', selfview: '自我认知', relation: '关系记忆',
    memory: '记忆', person: '人物', thing: '事件', topic: '话题', place: '地点',
  }[kind] || '记忆'
  const tone = toneOfKind(kind === 'memory' ? 'episode' : kind)
  const created = d.created_at ? relTime(d.created_at) : ''
  nodeCard.hidden = false
  nodeCard.innerHTML = `
    <button class="nc-close" type="button" aria-label="关闭">✕</button>
    <div class="nc-kind">${esc(kindLabel)}</div>
    <div class="nc-title">${esc(name)}</div>
    <div class="nc-meta">
      ${created ? `<span>${esc(created)}</span>` : ''}
      ${d.importance != null ? `<span>重要度 ${Math.round(Number(d.importance) * 100)}%</span>` : ''}
      ${d.degree != null ? `<span>${esc(d.degree)} 个关联</span>` : ''}
      <span class="${toneClass(tone)}" style="color:var(--tone)">●</span>
    </div>`
  nodeCard.querySelector('.nc-close').addEventListener('click', hideNodeCard)
  if (node?.id) state.brain?.select?.(node.id)
}


/* ------------------------------------------------------------ 退出登录 → 对话 */
/**
 * 在 DSH 面板里，“退出登录”应直接回到会话的「对话」tab。
 * 页面在宿主 iframe 内且同源，所以优先点击宿主的「对话」tab；
 * 找不到时再 postMessage 给 client 插件，由它调用 slot 的 openView('chat')。
 * 独立打开页面时保留原来的锁屏行为。
 */
function clickHostChatTab() {
  try {
    const host = window.parent
    if (!host || host === window) return false
    const doc = host.document
    if (!doc) return false
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
    const pool = [...doc.querySelectorAll('[role="tab"], button, a, [role="button"]')]
    const tab = pool.find((el) => norm(el.textContent) === '对话')
    if (!tab) return false
    const target = tab.closest('button, [role="tab"], [role="button"], a') || tab
    target.click()
    return true
  } catch (e) {
    console.warn('[memory-brain] 切换对话 tab 失败：', e)
    return false
  }
}

function exitToChat() {
  if (clickHostChatTab()) return
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'memory-brain:exit-to-chat' }, window.location.origin)
      toast('正在返回对话…', 1200)
      return
    }
  } catch {}
  openLock(() => toast('已解锁，继续查看'))
}

/* ------------------------------------------------------------ 设置 */
function applySetting(key, value) {
  state.settings[key] = value
  if (key === 'flow') state.brain?.setRunning?.(value)
  if (key === 'spin') state.brain?.setAutoRotate?.(value)
  if (key === 'orbit') state.brain?.setPointer?.(value)
  if (key === 'glow') state.brain?.setGlow?.(Number(value))
  if (key === 'density') state.brain?.setDensity?.(Number(value))
  if (key === 'bloom') state.brain?.setBloom?.({ threshold: Number(value) / 100 })
}

function openConsole() {
  openSettings({
    data: state.data || {},
    settings: state.settings,
    onChange: applySetting,
    onReset(next) {
      Object.assign(state.settings, next)
      state.brain?.setRunning?.(next.flow)
      state.brain?.setAutoRotate?.(next.spin)
      state.brain?.setPointer?.(next.orbit)
      state.brain?.setGlow?.(next.glow)
      state.brain?.setDensity?.(next.density)
      state.brain?.setBloom?.({ threshold: next.bloom / 100 })
    },
  })
}

/* ------------------------------------------------------------ 数据刷新 */
function applyMemoryView(limit=state.windowLimit) {
  if (!state.data || state.graphMode !== 'base') return
  state.windowLimit=limit
  const result=selectMemoryWindow(state.data,{...state.filter,limit})
  state.loaded=result.loaded;state.total=result.total
  state.brain?.setData?.(result.graph)
  left?.setLoaded?.(result.loaded,result.total)
  right?.setLoaded?.(result.loaded,result.total)
  return result
}
async function refresh(silent = false) {
  clearCache()
  const data = await loadAll()
  state.data = data
  state.loaded = Number(data.overview?.loaded ?? state.loaded)
  state.total = Number(data.overview?.total ?? state.total)
  window.__MEMORY_DATA = data
  if(panelHandlers) mountPanels({...data,overview:{...data.overview,timeRange:state.filter.range,memoryType:state.filter.type}},panelHandlers)
  applyMemoryView()
  if (!silent) toast('已更新到最新状态')
}

/* ------------------------------------------------------------ 装配 */
async function boot() {
  const data = await loadAll()
  state.data = data
  const type=data.overview?.memoryType || '全部类型'
  state.filter={range:data.overview?.timeRange || '最近30天',type,tone:({'事实':'fact','推理':'reasoning','后续/笔记':'followup'})[type] || 'all'}
  state.loaded = Number(data.overview?.loaded ?? data.memories?.length ?? 0)
  state.total = Number(data.overview?.total ?? state.loaded)
  state.windowLimit=Math.max(1,state.loaded || 200)
  window.__MEMORY_DATA = data

  const handlers = {
    onSyncHelp(anchor) {
      openSyncPopover(anchor, {
        version: data.version || data.status?.version,
        updatedAt: data.overview?.updatedAt,
      })
    },
    onConsole: openConsole,
    onRules: openRules,
    onLoop: openLoop,
    onSearch(q) {
      state.brain?.setOptions?.({ query: q })
      return search(q, 8)
    },
    onSearching() {},
    onSearchCleared() {
      state.brain?.setOptions?.({ query: '' })
    },
    onSelectMemory: async (item) => {
      const detail = await getNode(item.id, state.data).catch(() => null)
      showNodeCard(null, detail || item)
      if (item.id) state.brain?.select?.(String(item.id).startsWith('e') || String(item.id).startsWith('m') ? item.id : `m${item.id}`)
    },
    onFilter(f) {
      if(state.graphMode!=='base') return toast('闭环图谱请使用图谱工作区内的范围筛选')
      state.filter = f
      applyMemoryView()
      const map = { fact: '事实', reasoning: '推理', followup: '后续/笔记' }
      toast(`已切换：${f.range} · ${f.type || map[f.tone] || '全部类型'}`, 1500)
    },
    async onRefresh() {
      await refresh()
    },
    async onLoadMore() {
      if(state.graphMode!=='base') { toast('闭环图谱请在图谱工作区调整查询范围');return {loaded:state.loaded,total:state.total} }
      return applyMemoryView(state.windowLimit+200)
    },
    onFlow(on) {
      state.settings.flow = on
      state.brain?.setRunning?.(on)
    },
    onSpin(on) {
      state.settings.spin = on
      state.brain?.setAutoRotate?.(on)
    },
    onOrbit(on) {
      state.settings.orbit = on
      state.brain?.setPointer?.(on)
      if (on) toast('拖拽画面可旋转视角，滚轮缩放')
    },
    onReset() {
      state.brain?.reset?.()
      toast('视角已重置')
    },
    onSettings: openConsole,
    async onFullscreen() {
      try {
        if (!document.fullscreenElement) await document.documentElement.requestFullscreen()
        else await document.exitFullscreen()
      } catch {
        toast('当前环境不允许全屏')
      }
    },
    async onRefreshClick() { await refresh() },
    onLogout() {
      exitToChat()
    },
  }

  panelHandlers=handlers
  mountPanels(data,handlers)

  // 3D：默认隐藏舞台环/底座，只留脑体 + 光雾，对齐新设计
  setLoading(true, '正在加载记忆皮层…')
  try {
    state.brain = await mountBrain(canvas, {
      data: data.graph,
      still,
      art: false,
      glow: num('glow', state.settings.glow),
      density: num('density', state.settings.density),
      bloom: {
        strength: num('bloomStrength', 0.70),
        radius: num('bloomRadius', 0.30),
        threshold: num('bloomThreshold', state.settings.bloom / 100),
      },
      exposure: num('exposure', 0.80),
      haze: false,
      onSelect(node) {
        showNodeCard(node, {
          name: node.label || node.name,
          kind: node.kind || node.category,
          importance: node.importance,
          degree: node.degree,
        })
      },
    })
    window.__BRAIN = state.brain
    applyMemoryView()
    setLoading(false)
  } catch (e) {
    fail(e)
  }

  const cssFilter = params.get('filter')
  if (cssFilter) canvas.style.filter = cssFilter

  // ?ui=settings 直接打开设置，便于截图与验收
  if ((params.get('ui') || '').split(',').includes('settings')) openConsole()
  if ((params.get('ui') || '').split(',').includes('graph')) openLoop({view:'graph'})
}

boot().catch(fail)

/**
 * 中央立体大脑投射：闭环抽屉把真实记忆/本体/规则图送进 3D 脑。
 * loop 模式的数据来自 /api/loop/graph（节点/边都来自真实记录）；base 恢复默认 payload。
 */
window.__MB_SET_GRAPH__ = async (mode = 'loop', opts = {}) => {
  const apiBase = (typeof window !== 'undefined' && window.__MC_API_BASE__) || '/api'
  if (mode === 'loop') {
    const qs = new URLSearchParams({ owner: opts.owner || 'local-user', limit: String(opts.limit || 200) })
    if (opts.project) qs.set('project', opts.project)
    const res = await fetch(`${apiBase}/loop/graph?${qs}`, { cache: 'no-store' })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    state.graphMode='loop'
    state.brain?.setData?.({ nodes: data.nodes, edges: data.edges, memories: [] })
    return data.counts
  }
  state.graphMode='base'
  const base = applyMemoryView()?.graph || {nodes:[],edges:[],memories:[]}
  return { nodes: base.nodes?.length || 0, edges: base.edges?.length || 0 }
}

// 供 QA 工具读取
window.__APP = {
  state,
  get data() { return state.data },
  showNodeCard,
  hideNodeCard,
  openConsole,
  refresh,
  icons,
}
