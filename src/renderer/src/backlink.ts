/**
 * 反向链接面板：显示引用当前文档的书库条目。
 * 数据来自索引服务 index:backlinks；点击条目跳转到引用方文档对应行。
 */

let openFileFn: ((path: string, opts?: { line?: number }) => Promise<boolean> | void) | null = null

export function setBacklinkNav(fn: (path: string, opts?: { line?: number }) => Promise<boolean> | void) {
  openFileFn = fn
}

function baseName(p: string): string {
  return p.split('/').pop() ?? p
}

export async function refreshBacklinks(currentPath: string | null): Promise<void> {
  const host = document.getElementById('backlink-list')
  if (!host) return
  host.innerHTML = ''
  if (!currentPath) return
  const name = baseName(currentPath).replace(/\.(md|markdown|mdx)$/i, '')
  const links = await window.mdr.indexBacklinks(name).catch(() => [])
  if (!links.length) {
    const empty = document.createElement('div')
    empty.className = 'tree-empty'
    empty.textContent = '（无引用）'
    host.appendChild(empty)
    return
  }
  for (const l of links) {
    const item = document.createElement('div')
    item.className = 'backlink-item'
    item.innerHTML = `<span class="bl-file"></span><span class="bl-line">:${l.line}</span>`
    ;(item.querySelector('.bl-file') as HTMLElement).textContent = baseName(l.path)
    item.title = l.path
    item.addEventListener('click', () => {
      void openFileFn?.(l.path, { line: l.line })
    })
    host.appendChild(item)
  }
}
