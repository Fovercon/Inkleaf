import { getState, saveState, runtime } from './state'

export interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: TreeNode[]
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type Editing =
  | { mode: 'rename'; path: string; isDir: boolean }
  | { mode: 'create'; dir: string; kind: 'file' | 'dir' }
  | null

const DRAG_TYPE = 'application/x-mdr-tree'

export class FileTree {
  private selected: string | null = null
  private lastClickedDir: string | null = null
  private nodes: TreeNode[] = []
  private menu: HTMLDivElement | null = null
  private filterQuery = ''
  private editing: Editing = null

  onOpenFile: ((path: string) => void) | null = null
  onCreated: ((path: string) => void) | null = null
  onRenamed: ((info: { oldPath: string; newPath: string; isDir: boolean }) => void) | null = null
  onDeleted: ((path: string) => void) | null = null

  constructor(private host: HTMLElement) {
    document.addEventListener('click', () => this.hideMenu())
    window.addEventListener('blur', () => this.hideMenu())
    // right-click on empty tree area creates at the library root
    this.host.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.tree-row')) return
      if (!runtime.libraryRoot) return
      e.preventDefault()
      this.showCreateMenu(e, runtime.libraryRoot)
    })
  }

  async refresh() {
    this.nodes = await window.mdr.readTree()
    this.render()
  }

  /** directory that "new file" should land in: parent of selection, else last clicked folder, else root */
  currentDir(root: string | null): string | null {
    if (this.selected) {
      const dir = this.selected.slice(0, this.selected.lastIndexOf('/'))
      if (dir) return dir
    }
    return this.lastClickedDir ?? root
  }

  markSelected(path: string | null) {
    this.selected = path
    this.render()
  }

  setFilter(q: string) {
    this.filterQuery = q.trim()
    this.render()
  }

  /** briefly highlight a folder/file row (used when the breadcrumb reveals it) */
  flash(path: string) {
    const row = this.host.querySelector<HTMLElement>(`.tree-row[data-path="${CSS.escape(path)}"]`)
    if (!row) return
    row.classList.remove('flash')
    void row.offsetWidth // restart animation
    row.classList.add('flash')
    setTimeout(() => row.classList.remove('flash'), 1300)
  }

  startRename(path: string) {
    const node = this.findNode(path)
    if (!node) return
    this.editing = { mode: 'rename', path, isDir: node.type === 'dir' }
    this.render()
  }

  startCreate(dir: string, kind: 'file' | 'dir') {
    const set = new Set(getState().expandedDirs)
    set.add(dir)
    getState().expandedDirs = [...set]
    saveState()
    this.editing = { mode: 'create', dir, kind }
    this.render()
  }

  // ---------------- rendering ----------------

  private render() {
    const expanded = new Set(getState().expandedDirs)
    this.host.innerHTML = ''
    this.host.appendChild(this.buildList(this.filteredNodes(), expanded))
  }

  private filteredNodes(): TreeNode[] {
    if (!this.filterQuery) return this.nodes
    const ql = this.filterQuery.toLowerCase()
    const walk = (ns: TreeNode[]): TreeNode[] => {
      const out: TreeNode[] = []
      for (const n of ns) {
        if (n.type === 'file') {
          if (n.name.toLowerCase().includes(ql)) out.push(n)
        } else {
          const children = walk(n.children ?? [])
          if (children.length || n.name.toLowerCase().includes(ql)) out.push({ ...n, children })
        }
      }
      return out
    }
    return walk(this.nodes)
  }

  private hlName(name: string): string {
    const esc = escapeHtml(name)
    if (!this.filterQuery) return esc
    try {
      return esc.replace(new RegExp(`(${escapeRegExp(escapeHtml(this.filterQuery))})`, 'ig'), '<span class="hl">$1</span>')
    } catch {
      return esc
    }
  }

  private buildList(nodes: TreeNode[], expanded: Set<string>): HTMLUListElement {
    const ul = document.createElement('ul')
    ul.className = 'tree-list'
    for (const n of nodes) {
      const li = document.createElement('li')
      const row = document.createElement('div')
      const isSelected = n.type === 'file' && n.path === this.selected
      row.className = 'tree-row' + (isSelected ? ' selected' : '')
      row.dataset.path = n.path

      // drag to move into folders (Obsidian-style)
      row.draggable = true
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(DRAG_TYPE, n.path)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
        row.classList.add('dragging')
      })
      row.addEventListener('dragend', () => row.classList.remove('dragging'))
      if (n.type === 'dir') {
        row.addEventListener('dragover', (e) => {
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
          row.classList.add('drop-target')
        })
        row.addEventListener('dragleave', () => row.classList.remove('drop-target'))
        row.addEventListener('drop', (e) => {
          e.preventDefault()
          e.stopPropagation()
          row.classList.remove('drop-target')
          const src = e.dataTransfer?.getData(DRAG_TYPE)
          if (src) void this.applyMove(src, n.path)
        })
      }

      if (n.type === 'dir') {
        const isOpen = expanded.has(n.path) || !!this.filterQuery
        row.innerHTML =
          `<span class="disclosure">${isOpen ? '▾' : '▸'}</span>` +
          `<span class="tree-name folder">${this.hlName(n.name)}</span>`
        row.addEventListener('click', () => {
          this.lastClickedDir = n.path
          const set = new Set(getState().expandedDirs)
          if (set.has(n.path)) set.delete(n.path)
          else set.add(n.path)
          getState().expandedDirs = [...set]
          saveState()
          this.render()
        })
        li.appendChild(row)
        if (isOpen) {
          if (this.editing?.mode === 'create' && this.editing.dir === n.path) {
            li.appendChild(this.makeCreateInput(this.editing.dir, this.editing.kind))
          }
          if (n.children?.length) {
            li.appendChild(this.buildList(n.children, expanded))
          } else if (!this.filterQuery) {
            const empty = document.createElement('div')
            empty.className = 'tree-empty'
            empty.textContent = '（空）'
            li.appendChild(empty)
          }
        }
      } else {
        const isRenaming = this.editing?.mode === 'rename' && this.editing.path === n.path
        if (isRenaming) {
          row.innerHTML = '<span class="disclosure"></span>'
          row.appendChild(this.makeRenameInput(n.name, n.path))
        } else {
          row.innerHTML =
            '<span class="disclosure"></span>' +
            `<span class="tree-name file">${this.hlName(n.name)}</span>`
          row.addEventListener('click', () => {
            this.selected = n.path
            this.onOpenFile?.(n.path)
            this.render()
          })
        }
        li.appendChild(row)
      }

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.showNodeMenu(e, n)
      })
      ul.appendChild(li)
    }
    // root-level inline creation
    if (this.editing?.mode === 'create' && this.editing.dir === runtime.libraryRoot) {
      const li = document.createElement('li')
      li.appendChild(this.makeCreateInput(this.editing.dir, this.editing.kind))
      ul.appendChild(li)
    }
    return ul
  }

  private findNode(path: string): TreeNode | null {
    const walk = (ns: TreeNode[]): TreeNode | null => {
      for (const n of ns) {
        if (n.path === path) return n
        if (n.children) {
          const found = walk(n.children)
          if (found) return found
        }
      }
      return null
    }
    return walk(this.nodes)
  }

  // ---------------- inline inputs ----------------

  private makeRenameInput(oldName: string, oldPath: string) {
    const input = document.createElement('input')
    input.className = 'tree-input'
    input.type = 'text'
    input.value = oldName
    const commit = () => {
      const name = input.value.trim()
      this.editing = null
      if (name && name !== oldName) void this.applyRename(oldPath, name)
      else this.render()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') commit()
      if (e.key === 'Escape') {
        this.editing = null
        this.render()
      }
    })
    input.addEventListener('blur', () => commit())
    setTimeout(() => {
      input.focus()
      const dot = oldName.lastIndexOf('.')
      input.setSelectionRange(0, dot > 0 ? dot : oldName.length)
    })
    return input
  }

  private makeCreateInput(dir: string, kind: 'file' | 'dir') {
    const wrap = document.createElement('div')
    wrap.className = 'tree-row editing'
    const input = document.createElement('input')
    input.className = 'tree-input'
    input.type = 'text'
    input.placeholder = kind === 'dir' ? '文件夹名称' : '文件名称（.md）'
    wrap.appendChild(input)
    const commit = () => {
      const name = input.value.trim()
      this.editing = null
      if (name) void this.applyCreate(dir, kind, name)
      else this.render()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') commit()
      if (e.key === 'Escape') {
        this.editing = null
        this.render()
      }
    })
    input.addEventListener('blur', () => commit())
    setTimeout(() => input.focus())
    return wrap
  }

  private async applyRename(oldPath: string, name: string) {
    const isDir = this.findNode(oldPath)?.type === 'dir'
    const finalName = !isDir && !/\.(md|markdown|mdx)$/i.test(name) ? `${name}.md` : name
    const dir = oldPath.slice(0, oldPath.lastIndexOf('/'))
    const newPath = `${dir}/${finalName}`
    if (newPath === oldPath) return this.refresh()
    if (await window.mdr.exists(newPath)) {
      await window.mdr.confirm({ title: '无法重命名', message: `“${finalName}” 已存在`, okLabel: '知道了' })
      return this.refresh()
    }
    const r = await window.mdr.rename(oldPath, newPath)
    if (!r.ok) {
      await window.mdr.confirm({ title: '无法重命名', message: r.error ?? '未知错误', okLabel: '知道了' })
    } else {
      if (this.selected === oldPath) this.selected = newPath
      this.onRenamed?.({ oldPath, newPath, isDir })
      await this.refresh()
      this.flash(newPath)
    }
  }

  /** drag-and-drop: move a file/folder into the target directory */
  private async applyMove(src: string, targetDir: string) {
    if (src === targetDir || targetDir.startsWith(src + '/')) return // cannot move into itself
    const name = src.split('/').pop() ?? src
    const newPath = `${targetDir}/${name}`
    if (newPath === src) return
    if (await window.mdr.exists(newPath)) {
      await window.mdr.confirm({ title: '无法移动', message: `目标文件夹中已存在“${name}”`, okLabel: '知道了' })
      return this.refresh()
    }
    const r = await window.mdr.rename(src, newPath)
    if (!r.ok) {
      await window.mdr.confirm({ title: '无法移动', message: r.error ?? '未知错误', okLabel: '知道了' })
      return this.refresh()
    }
    if (this.selected === src || (this.selected?.startsWith(src + '/') ?? false)) this.selected = newPath
    this.onRenamed?.({ oldPath: src, newPath, isDir: this.findNode(src)?.type === 'dir' })
    await this.refresh()
    this.flash(newPath)
  }

  private async applyCreate(dir: string, kind: 'file' | 'dir', name: string) {
    const finalName = kind === 'file' && !/\.(md|markdown|mdx)$/i.test(name) ? `${name}.md` : name
    const p = `${dir}/${finalName}`
    if (await window.mdr.exists(p)) {
      await window.mdr.confirm({ title: '无法创建', message: `“${finalName}” 已存在`, okLabel: '知道了' })
      return this.refresh()
    }
    if (kind === 'dir') {
      await window.mdr.mkdir(p)
      await this.refresh()
      this.flash(p)
    } else {
      const base = finalName.replace(/\.(md|markdown|mdx)$/i, '')
      await window.mdr.writeFile(p, `# ${base}\n\n`)
      await this.refresh()
      this.onCreated?.(p)
    }
  }

  private async applyDelete(n: TreeNode) {
    const ok = await window.mdr.confirm({
      title: '移到废纸篓',
      message: `确定将“${n.name}”移到废纸篓吗？${n.type === 'dir' ? '文件夹内的内容会一并移入。' : ''}`,
      okLabel: '移到废纸篓',
    })
    if (!ok) return
    await window.mdr.trash(n.path)
    this.onDeleted?.(n.path)
    await this.refresh()
  }

  // ---------------- context menus ----------------

  private showNodeMenu(e: MouseEvent, n: TreeNode) {
    this.hideMenu()
    const menu = document.createElement('div')
    menu.className = 'ctx-menu'
    const addItem = (label: string, fn: () => void, danger = false) => {
      const btn = document.createElement('button')
      btn.className = 'ctx-item' + (danger ? ' danger' : '')
      btn.textContent = label
      btn.addEventListener('click', () => {
        this.hideMenu()
        fn()
      })
      menu.appendChild(btn)
    }
    if (n.type === 'dir') {
      addItem('新建文件', () => this.startCreate(n.path, 'file'))
      addItem('新建文件夹', () => this.startCreate(n.path, 'dir'))
      menu.appendChild(this.menuSep())
    }
    addItem('重命名', () => this.startRename(n.path))
    addItem('在 Finder 中显示', () => window.mdr.reveal(n.path))
    // keep rename and delete separated to avoid Obsidian-style mis-clicks
    menu.appendChild(this.menuSep())
    addItem('删除…', () => void this.applyDelete(n), true)
    document.body.appendChild(menu)
    this.placeMenu(menu, e)
    this.menu = menu
  }

  private showCreateMenu(e: MouseEvent, dir: string) {
    this.hideMenu()
    const menu = document.createElement('div')
    menu.className = 'ctx-menu'
    const addItem = (label: string, fn: () => void) => {
      const btn = document.createElement('button')
      btn.className = 'ctx-item'
      btn.textContent = label
      btn.addEventListener('click', () => {
        this.hideMenu()
        fn()
      })
      menu.appendChild(btn)
    }
    addItem('新建文件', () => this.startCreate(dir, 'file'))
    addItem('新建文件夹', () => this.startCreate(dir, 'dir'))
    document.body.appendChild(menu)
    this.placeMenu(menu, e)
    this.menu = menu
  }

  private menuSep() {
    const sep = document.createElement('div')
    sep.className = 'ctx-sep'
    return sep
  }

  private placeMenu(menu: HTMLDivElement, e: MouseEvent) {
    const x = Math.min(e.clientX, window.innerWidth - 180)
    const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 80)
    menu.style.left = x + 'px'
    menu.style.top = y + 'px'
  }

  private hideMenu() {
    this.menu?.remove()
    this.menu = null
  }
}
