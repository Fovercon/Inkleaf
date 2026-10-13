import { getState, saveState, ThemePref } from './state'

export type ResolvedTheme = 'light' | 'sepia' | 'green' | 'dark'

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

export function isDark(): boolean {
  return resolved === 'dark'
}

export function setTheme(t: ThemePref) {
  getState().theme = t
  saveState()
  applyTheme()
}

const CYCLE: ThemePref[] = ['auto', 'light', 'sepia', 'green', 'dark']

export function cycleTheme() {
  const cur = getState().theme
  setTheme(CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length])
}

export function onThemeChange(cb: (t: ResolvedTheme) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

mq.addEventListener('change', () => {
  if (getState().theme === 'auto') applyTheme()
})
