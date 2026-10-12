import { getState, saveState, ThemePref } from './state'

export type ResolvedTheme = 'light' | 'dark'

const mq = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<(t: ResolvedTheme) => void>()
let resolved: ResolvedTheme = 'light'

export function applyTheme() {
  const pref = getState().theme
  resolved = pref === 'auto' ? (mq.matches ? 'dark' : 'light') : pref
  document.body.dataset.theme = resolved
  listeners.forEach((fn) => fn(resolved))
}

export function currentTheme(): ResolvedTheme {
  return resolved
}

export function setTheme(t: ThemePref) {
  getState().theme = t
  saveState()
  applyTheme()
}

export function cycleTheme() {
  const order: ThemePref[] = ['auto', 'light', 'dark']
  const cur = getState().theme
  setTheme(order[(order.indexOf(cur) + 1) % order.length])
}

export function onThemeChange(cb: (t: ResolvedTheme) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

mq.addEventListener('change', () => {
  if (getState().theme === 'auto') applyTheme()
})
