import { element } from './toolDialog'
let openFileFn: ((path: string, opts?: { line?: number }) => Promise<boolean> | void) | null = null
let request = 0
export function setBacklinkNav(fn: (path: string, opts?: { line?: number }) => Promise<boolean> | void) { openFileFn = fn }
export async function refreshBacklinks(currentPath: string | null): Promise<void> {
  const epoch=++request, host=document.getElementById('backlink-list')
  if(!host) return
  host.replaceChildren(); if(!currentPath) return
  try {
    const result = window.mdr.indexRelations ? await window.mdr.indexRelations(currentPath) : { backlinks: await window.mdr.indexBacklinks(currentPath), mentions: [] }
    if(epoch!==request) return
    for(const [title,links] of [['反向链接',result.backlinks],['未链接提及',result.mentions]] as const) {
      host.append(element('h4',`${title} · ${links.length}`))
      if(!links.length) host.append(element('p','暂无记录','tree-empty'))
      for(const link of links) {
        const item=element('button','','backlink-item'); item.title=link.path
        item.append(element('strong',`${link.path.split('/').slice(-2).join('/')}:${link.line}`))
        if('context' in link) item.append(element('span',String(link.context),'bl-context'))
        item.onclick=()=>void openFileFn?.(link.path,{line:link.line}); host.append(item)
      }
    }
  } catch(error) { if(epoch===request) host.append(element('p',`读取引用失败：${String(error)}`,'tree-empty')) }
}
