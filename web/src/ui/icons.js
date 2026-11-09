// icons.js — 内联 SVG（stroke 用 currentColor，尺寸由 CSS 决定）
const S = (body, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`

export const icons = {
  brain: `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M15.4 5.1c-1.5-1.9-4.4-2.1-6.2-.4-2.2-.9-4.6.5-4.9 2.9-2.1 1-2.9 3.6-1.6 5.5-1.3 1.9-.5 4.5 1.6 5.4.3 2.5 2.7 4.1 5 3.3.9 1.9 3.2 2.7 5.1 1.8 1.6 1.2 3.9 1.2 5.5 0 1.9.9 4.2.1 5.1-1.8 2.3.8 4.7-.8 5-3.3 2.1-.9 2.9-3.5 1.6-5.4 1.3-1.9.5-4.5-1.6-5.5-.3-2.4-2.7-3.8-4.9-2.9-1.8-1.7-4.7-1.5-6.2.4"/>
    <path d="M15.4 5.4v18.2c0 1.8.5 3.1 1.5 4.1"/>
    <path d="M9.2 7.1c-1.1 1-1.1 2.5.1 3.3M7.8 14.2c1.6-.6 2.7.5 1.8 1.7M18.6 8.3c1 1 1 2.4-.1 3.2M20 14.8c-1.5-.5-2.5.6-1.7 1.8"/>
    <circle cx="9.4" cy="9.6" r=".8" fill="currentColor" stroke="none"/>
    <circle cx="19.1" cy="10.3" r=".8" fill="currentColor" stroke="none"/>
    <circle cx="11.2" cy="18.1" r=".8" fill="currentColor" stroke="none"/>
    <circle cx="17.6" cy="18.6" r=".8" fill="currentColor" stroke="none"/>
  </svg>`,

  sync: S('<path d="M20 11a8 8 0 0 0-13.6-4.6L4 8.6"/><path d="M4 4v4.6h4.6"/><path d="M4 13a8 8 0 0 0 13.6 4.6L20 15.4"/><path d="M20 20v-4.6h-4.6"/>'),

  rule: S('<path d="M7 3.5h7.5L20 9v10.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 6 19.5v-14A1.5 1.5 0 0 1 7.5 4H7z"/><path d="M14.5 3.8V9H20"/><path d="m9.5 14.5 1.8 1.8 3.4-3.6"/>'),

  sliders: S('<path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h10M18 17h2"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="17" r="2"/>'),

  external: S('<path d="M7 17 17 7"/><path d="M9 7h8v8"/>'),

  chevron: `<svg viewBox="0 0 12 8" fill="none" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

  search: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="7" stroke="currentColor" stroke-width="1.7"/><path d="M16 16 21 21" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,

  triangle: `<svg viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path d="M1 2.2h8L5 8.2z"/></svg>`,

  waveform: `<svg viewBox="0 0 24 16" fill="none" aria-hidden="true"><path d="M1 8h3l2.4-5.4L9.2 13l2.6-7L14.2 8H23" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

  orbit: S('<circle cx="12" cy="12" r="3.2"/><path d="M4.2 8.4c-1.2 2.1 1.7 5.9 6.4 8.6 4.7 2.7 9.4 3.2 10.6 1.1 1.2-2.1-1.7-5.9-6.4-8.6"/><circle cx="19.4" cy="7.1" r="1" fill="currentColor" stroke="none"/>'),

  reset: S('<path d="M4.5 8.5A8 8 0 1 1 4 14"/><path d="M4 4v5h5"/>'),

  settings: S('<path d="M4 7h8M16 7h4M4 12h4M12 12h8M4 17h10M18 17h2"/><circle cx="14" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="17" r="2"/>'),

  fullscreen: S('<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9"/><path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9"/><path d="M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15"/><path d="M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>'),

  activity: S('<path d="M5.5 8.5a6.5 6.5 0 0 0 0 7M2.5 5.5a10.5 10.5 0 0 0 0 13M18.5 8.5a6.5 6.5 0 0 1 0 7M21.5 5.5a10.5 10.5 0 0 1 0 13"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>'),

  logout: S('<path d="M14 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H14"/><path d="M10 12h10"/><path d="m16 8 4 4-4 4"/>'),

  lock: S('<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"/><path d="M12 14v2"/>'),

  flow: S('<path d="M3 12c2.2 0 2.2-5 4.5-5s2.3 10 4.5 10 2.3-10 4.5-10S18.8 12 21 12"/>'),

  spin: S('<circle cx="12" cy="12" r="6.4"/><path d="M12 5.6c-3.5 0-6.4 2.9-6.4 6.4"/><path d="m8.7 3.3 3.4 2.2-2.1 3.1"/>'),

  pause: S('<rect x="7" y="5" width="3.4" height="14" rx="1"/><rect x="13.6" y="5" width="3.4" height="14" rx="1"/>'),

  play: S('<path d="M8 5.5v13l11-6.5z"/>'),
}

export function icon(name) { return icons[name] || '' }
