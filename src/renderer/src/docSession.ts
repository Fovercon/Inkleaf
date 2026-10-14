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
  /** Last disk content used to build this editor state. */
  diskContent: string | null
  stale: boolean
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
    return this.get()?.path ?? null
  }

  indexOf(path: string): number {
    return this.tabs.findIndex((t) => t.path === path)
  }

  /** 捕获当前 tab 的可变状态（切换/关闭前调用） */
  capture(editorJSON: unknown, scrollY: number, dirty: boolean): void {
    const t = this.get()
    if (!t) return
    t.editorJSON = editorJSON
    t.scrollY = scrollY
    t.dirty = dirty
  }

  capturePath(path: string, editorJSON: unknown, scrollY: number, dirty: boolean): void {
    const t = this.get(this.indexOf(path))
    if (!t) return
    t.editorJSON = editorJSON
    t.scrollY = scrollY
    t.dirty = dirty
  }

  all(): readonly DocSession[] {
    return [...this.tabs]
  }

  private create(path: string): DocSession {
    return { path, editorJSON: null, scrollY: 0, dirty: false, diskContent: null, stale: false }
  }

  /** 激活已有 tab 或新建；返回需要加载内容的 tab（懒加载） */
  activate(path: string, opts?: { newTab?: boolean }): DocSession {
    const existing = this.indexOf(path)
    // A file has one buffer, even when "open in a new tab" targets it again.
    if (existing >= 0) {
      this.active = existing
      this.onTabsChanged?.()
      return this.tabs[existing]
    }
    const session = this.create(path)
    if (!opts?.newTab && this.active >= 0) {
      // 默认打开 = 替换当前标签（Obsidian 同款语义）
      if (this.get()?.dirty) throw new Error('请先保存当前标签页，再打开其他文件')
      this.tabs[this.active] = session
    } else {
      if (this.tabs.length >= this.limit) {
        const victim = this.tabs.findIndex((t, i) => i !== this.active && !t.dirty)
        if (victim < 0) throw new Error('标签页已达上限，请先保存或关闭一个标签页')
        this.tabs.splice(victim, 1)
        if (victim < this.active) this.active--
      }
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
    if (this.tabs[i].dirty) throw new Error('标签页尚未保存，无法关闭')
    const current = this.get()
    this.tabs.splice(i, 1)
    if (this.tabs.length === 0) {
      this.active = -1
      this.onTabsChanged?.()
      return null
    }
    this.active = current ? this.tabs.indexOf(current) : -1
    if (this.active < 0) this.active = Math.min(i, this.tabs.length - 1)
    this.onTabsChanged?.()
    return this.tabs[this.active]
  }

  rename(oldPath: string, newPath: string, directory = false): void {
    let changed = false
    for (const tab of this.tabs) {
      if (tab.path === oldPath || directory && tab.path.startsWith(oldPath + '/')) {
        tab.path = newPath + tab.path.slice(oldPath.length)
        changed = true
      }
    }
    if (changed) this.onTabsChanged?.()
  }

  invalidate(path: string, directory = false): void {
    for (const tab of this.tabs) {
      if (tab.path !== path && !(directory && tab.path.startsWith(path + '/'))) continue
      tab.stale = true
      if (!tab.dirty) tab.editorJSON = null
    }
  }

  removePath(path: string, directory = false): DocSession | null {
    const current = this.get()
    const oldActive = this.active
    this.tabs = this.tabs.filter(tab => tab.path !== path && !(directory && tab.path.startsWith(path + '/')))
    this.active = current ? this.tabs.indexOf(current) : -1
    if (this.active < 0 && this.tabs.length) this.active = Math.min(Math.max(oldActive, 0), this.tabs.length - 1)
    if (!this.tabs.length) this.active = -1
    this.onTabsChanged?.()
    return this.get()
  }

  /** 会话持久化用的纯路径列表 */
  paths(): string[] {
    return this.tabs.map((t) => t.path)
  }

  restorePaths(paths: string[], activeIndex: number): void {
    const unique = [...new Set(paths.filter(path => typeof path === 'string' && path))]
    const requested = Number.isInteger(activeIndex) ? Math.max(0, Math.min(activeIndex, unique.length - 1)) : unique.length - 1
    const start = Math.max(0, Math.min(requested, unique.length - this.limit))
    this.tabs = unique.slice(start, start + this.limit).map(path => this.create(path))
    this.active = this.tabs.length ? requested - start : -1
    this.onTabsChanged?.()
  }
}
