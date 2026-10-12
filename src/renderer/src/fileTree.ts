import { getState, saveState } from './state'

export interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: TreeNode[]
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export class FileTree {
  private selected: string | null = null
  private lastClickedDir: string | null = null
  private nodes: TreeNode[] = []
  private menu: HTMLDivElement | null = null
  onOpenFile: ((path: string) => void) | null = null
  onNewFile: ((dir: string) => void) | null = null

  constructor(private host: HTMLElement) {
    document.addEventListener('click', () => this.hideMenu())
    window.addEventListener('blur', () => this.hideMenu())
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

  private render() {
    const expanded = new Set(getState().expandedDirs)
    this.host.innerHTML = ''
    this.host.appendChild(this.buildList(this.nodes, expanded))
  }

  private buildList(nodes: TreeNode[], expanded: Set<string>): HTMLUListElement {
    const ul = document.createElement('ul')
    ul.className = 'tree-list'
    for (const n of nodes) {
      const li = document.createElement('li')
      const row = document.createElement('div')
      const isSelected = n.type === 'file' && n.path === this.selected
      row.className = 'tree-row' + (isSelected ? ' selected' : '')

      if (n.type === 'dir') {
        const isOpen = expanded.has(n.path)
        row.innerHTML =
          `<span class="disclosure">${isOpen ? '▾' : '▸'}</span>` +
          `<span class="tree-name folder">${escapeHtml(n.name)}</span>`
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
          if (n.children?.length) li.appendChild(this.buildList(n.children, expanded))
          else {
            const empty = document.createElement('div')
            empty.className = 'tree-empty'
            empty.textContent = '（空）'
            li.appendChild(empty)
          }
        }
      } else {
        row.innerHTML =
          '<span class="disclosure"></span>' +
          `<span class="tree-name file">${escapeHtml(n.name)}</span>`
        row.addEventListener('click', () => {
          this.selected = n.path
          this.onOpenFile?.(n.path)
          this.render()
        })
        li.appendChild(row)
      }

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        this.showMenu(e, n)
      })
      ul.appendChild(li)
    }
    return ul
  }

  private showMenu(e: MouseEvent, n: TreeNode) {
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
    if (n.type === 'dir') {
      addItem('新建文件', () => this.onNewFile?.(n.path))
    }
    addItem('在 Finder 中显示', () => window.mdr.reveal(n.path))
    document.body.appendChild(menu)
    const x = Math.min(e.clientX, window.innerWidth - 180)
    const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 80)
    menu.style.left = x + 'px'
    menu.style.top = y + 'px'
    this.menu = menu
  }

  private hideMenu() {
    this.menu?.remove()
    this.menu = null
  }
}
