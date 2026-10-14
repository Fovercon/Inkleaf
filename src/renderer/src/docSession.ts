/**
 * DocSession —— 集中文档会话（docs/04 §十 步骤 5 · 多标签页的地基）。
 * 每个 Tab 一份：路径、可序列化编辑器状态（含撤销历史）、预览滚动、脏标志。
 * A5 问题（状态多副本靠手工同步）的消解点：tab 生命周期与状态捕获集中于此。
 */

export interface DocSession {
  path: string
  /** CodeMirror EditorState.toJSON 产物（含 undo 历史）；懒加载 tab 为 null */
  editorJSON: unknown
  scrollY: number
  dirty: boolean
}

export class TabManager {
  private tabs: DocSession[] = []
  private active = -1
  private limit = 12

  onTabsChanged: (() => void) | null = null

  get count(): number {
    return this.tabs.length
  }

  get activeIndex(): number {
    return this.active
  }

  get activePath(): string | null {
    return this.active >= 0 ? this.tabs[this.active].path : null
  }

  indexOf(path: string): number {
    return this.tabs.findIndex((t) => t.path === path)
  }

  /** 捕获当前 tab 的可变状态（切换/关闭前调用） */
  capture(editorJSON: unknown, scrollY: number, dirty: boolean): void {
    if (this.active < 0) return
    const t = this.tabs[this.active]
    t.editorJSON = editorJSON
    t.scrollY = scrollY
    t.dirty = dirty
  }

  /** 激活已有 tab 或新建；返回需要加载内容的 tab（懒加载） */
  activate(path: string, opts?: { newTab?: boolean }): DocSession {
    const existing = this.indexOf(path)
    if (existing >= 0 && !opts?.newTab) {
      this.active = existing
      this.onTabsChanged?.()
      return this.tabs[existing]
    }
    if (this.tabs.length >= this.limit) {
      // 上限：淘汰最老的非激活 tab
      const victim = this.tabs.findIndex((t, i) => i !== this.active)
      if (victim >= 0) this.tabs.splice(victim, 1)
    }
    const session: DocSession = { path, editorJSON: null, scrollY: 0, dirty: false }
    if (!opts?.newTab && this.active >= 0) {
      // 默认打开 = 替换当前标签（Obsidian 同款语义）
      this.tabs[this.active] = session
    } else {
      const at = this.active >= 0 ? this.active + 1 : this.tabs.length
      this.tabs.splice(at, 0, session)
    }
    this.active = this.tabs.indexOf(session)
    this.onTabsChanged?.()
    return session
  }

  get(i = this.active): DocSession | null {
    return i >= 0 && i < this.tabs.length ? this.tabs[i] : null
  }

  /** 关闭指定 tab；返回应激活的 tab（可能为 null = 全部关闭） */
  close(i = this.active): DocSession | null {
    if (i < 0 || i >= this.tabs.length) return null
    this.tabs.splice(i, 1)
    if (this.tabs.length === 0) {
      this.active = -1
      this.onTabsChanged?.()
      return null
    }
    this.active = Math.min(i, this.tabs.length - 1)
    this.onTabsChanged?.()
    return this.tabs[this.active]
  }

  /** 会话持久化用的纯路径列表 */
  paths(): string[] {
    return this.tabs.map((t) => t.path)
  }

  restorePaths(paths: string[], activeIndex: number): void {
    this.tabs = paths.map((p) => ({ path: p, editorJSON: null, scrollY: 0, dirty: false }))
    this.active = this.tabs.length ? Math.max(0, Math.min(activeIndex, this.tabs.length - 1)) : -1
    this.onTabsChanged?.()
  }
}
