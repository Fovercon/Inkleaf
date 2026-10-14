export type ThemePref = 'auto' | 'light' | 'sepia' | 'green' | 'dark'
export type PaneKey = 'sidebar' | 'editor' | 'preview' | 'outline'

export interface UiState {
  theme: ThemePref
  /** preview/editor base font multiplier */
  fontScale: number
  /** dim everything except the active block */
  focusMode: boolean
  /** keep the cursor vertically centered while typing */
  typewriter: boolean
  /** 面板开合状态（键为面板 id；面板注册表可动态扩展） */
  collapsed: Record<string, boolean>
  /** 面板宽度（键为面板 id） */
  widths: Record<string, number>
  expandedDirs: string[]
  recent: string[]
  scrollByPath: Record<string, number>
  sidebarTab: 'files' | 'recent'
}

const KEY = 'mdr.ui.v1'

const DEFAULTS: UiState = {
  theme: 'auto',
  fontScale: 1,
  focusMode: false,
  typewriter: false,
  collapsed: { sidebar: false, editor: false, preview: false, outline: false },
  widths: { sidebar: 224, editor: 400, outline: 184 },
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
      fontScale: typeof p.fontScale === 'number' ? Math.min(1.6, Math.max(0.8, p.fontScale)) : 1,
      focusMode: p.focusMode === true,
      typewriter: p.typewriter === true,
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
