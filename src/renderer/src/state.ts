export type ThemePref = 'auto' | 'light' | 'dark'
export type PaneKey = 'sidebar' | 'editor' | 'preview' | 'outline'

export interface UiState {
  theme: ThemePref
  collapsed: Record<PaneKey, boolean>
  widths: { sidebar: number; editor: number; outline: number }
  expandedDirs: string[]
  recent: string[]
  scrollByPath: Record<string, number>
  sidebarTab: 'files' | 'recent'
}

const KEY = 'mdr.ui.v1'

const DEFAULTS: UiState = {
  theme: 'auto',
  collapsed: { sidebar: false, editor: false, preview: false, outline: false },
  widths: { sidebar: 240, editor: 460, outline: 220 },
  expandedDirs: [],
  recent: [],
  scrollByPath: {},
  sidebarTab: 'files',
}

function load(): UiState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return structuredClone(DEFAULTS)
    const p = JSON.parse(raw) as Partial<UiState>
    return {
      ...DEFAULTS,
      ...p,
      collapsed: { ...DEFAULTS.collapsed, ...(p.collapsed ?? {}) },
      widths: { ...DEFAULTS.widths, ...(p.widths ?? {}) },
      expandedDirs: p.expandedDirs ?? [],
      recent: p.recent ?? [],
      scrollByPath: p.scrollByPath ?? {},
      sidebarTab: p.sidebarTab === 'recent' ? 'recent' : 'files',
    }
  } catch {
    return structuredClone(DEFAULTS)
  }
}

let state: UiState = load()

export function getState(): UiState {
  return state
}

export function saveState() {
  localStorage.setItem(KEY, JSON.stringify(state))
}

// runtime (non-persisted) context for the current session
export const runtime = {
  libraryRoot: null as string | null,
  currentFile: null as string | null,
}
