// util.js — 纯函数与展示格式
export const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))

export const fmt = (n) => {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return Number(n).toLocaleString('en-US')
}

export const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`

/** 相对时间：秒 / 毫秒都接受 */
export function relTime(sec) {
  if (!sec) return ''
  const t = sec > 1e12 ? sec : sec * 1000
  const d = Date.now() - t
  if (d < 0) return '刚刚'
  const min = d / 60000
  if (min < 1) return '刚刚'
  if (min < 60) return `${Math.floor(min)} 分钟前`
  const h = min / 60
  if (h < 24) return `${Math.floor(h)} 小时前`
  const day = h / 24
  if (day < 30) return `${Math.floor(day)} 天前`
  const mo = day / 30
  if (mo < 12) return `${Math.floor(mo)} 个月前`
  return `${Math.floor(mo / 12)} 年前`
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

export function debounce(fn, ms = 160) {
  let timer = 0
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

/** 从数据里取第一个存在值的字段（兼容旧 payload） */
export function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] != null) return obj[k]
  return undefined
}

export function toneOfKind(kind) {
  if (kind === 'fact') return 'fact'
  if (['reflection', 'skill', 'review', 'self', 'selfview', 'relation'].includes(kind)) return 'reasoning'
  return 'followup'
}

export function toneClass(tone) {
  return `tone-${tone || 'cyan'}`
}
