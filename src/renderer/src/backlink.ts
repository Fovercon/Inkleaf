import { element } from './toolDialog'
import type { RelationResult } from '../../shared/ipc'
let openFileFn: ((path: string, opts?: { line?: number }) => Promise<boolean> | void) | null = null
let request = 0
export function setBacklinkNav(fn: (path: string, opts?: { line?: number }) => Promise<boolean> | void) { openFileFn = fn }
export async function refreshBacklinks(currentPath: string | null, scanMentions = false): Promise<void> {
  const epoch=++request, host=document.getElementById('backlink-list')
  if(!host) return
  host.replaceChildren()
  if (!currentPath || host.closest('.pane-collapsed')) {
    void window.mdr.indexRelations?.(null).catch(() => {})
    return
  }
  host.append(element('p', scanMentions ? '正在查找未链接提及…' : '正在读取引用…', 'tree-empty'))
  try {
    const result: RelationResult = window.mdr.indexRelations ? await window.mdr.indexRelations(currentPath, scanMentions) : { backlinks: (await window.mdr.indexBacklinks(currentPath)).map(link => ({ ...link, context: '' })), mentions: [] }
    if(epoch!==request) return
    host.replaceChildren()
    for(const [title,links] of [['反向链接',result.backlinks],['未链接提及',result.mentions]] as const) {
      if (title === '未链接提及' && result.mentionsDeferred) {
        const scan = element('button', '查找未链接提及', 'backlink-item')
        scan.onclick = () => void refreshBacklinks(currentPath, true)
        host.append(element('h4', title), scan)
        continue
      }
      host.append(element('h4',`${title} · ${links.length}`))
      if(!links.length) host.append(element('p','暂无记录','tree-empty'))
      for(const link of links) {
        const item=element('button','','backlink-item'); item.title=link.path
        item.append(element('strong',`${link.path.split('/').slice(-2).join('/')}:${link.line}`))
        if('context' in link) item.append(element('span',String(link.context).replace(/<br\s*\/?>/gi,'\n'),'bl-context'))
        item.onclick=()=>void openFileFn?.(link.path,{line:link.line}); host.append(item)
      }
    }
  } catch(error) { if(epoch===request) host.replaceChildren(element('p',`读取引用失败：${String(error)}`,'tree-empty')) }
}
