import { getState, saveState, type UiState } from './state'
import { element, input, toolDialog } from './toolDialog'
export interface LibraryWorkspace { tabs: string[]; activeIndex: number; expanded: string[] }
export type Layout = Pick<UiState, 'collapsed' | 'widths' | 'focusMode' | 'typewriter'>
interface WorkspaceStore { version: 1; recent: string[]; libraries: Record<string, LibraryWorkspace>; layouts: Record<string, Layout> }
const KEY = 'inkleaf.workspaces.v1'
function read(): WorkspaceStore {
  const raw = localStorage.getItem(KEY)
  if (!raw) return { version: 1, recent: [], libraries: {}, layouts: {} }
  const value = JSON.parse(raw) as WorkspaceStore
  if (value.version !== 1 || !Array.isArray(value.recent) || !value.libraries || !value.layouts) throw new Error('工作区设置无法读取，请保留数据后检查本机配置')
  return value
}
function write(store: WorkspaceStore) { localStorage.setItem(KEY, JSON.stringify(store)) }
export function rememberLibrary(root: string, workspace?: LibraryWorkspace) {
  const store = read(); store.recent = [root, ...store.recent.filter(p => p !== root)].slice(0, 30)
  if (workspace) store.libraries[root] = structuredClone(workspace)
  write(store)
}
export function libraryWorkspace(root: string): LibraryWorkspace | undefined {
  const value = read().libraries[root]
  if (!value || !Array.isArray(value.tabs) || !Array.isArray(value.expanded)) return undefined
  const inside = (p: string) => typeof p === 'string' && p.startsWith(root === '/' ? '/' : root + '/')
  return { tabs: value.tabs.filter(inside), activeIndex: value.activeIndex, expanded: value.expanded.filter(inside) }
}
export function openLibraries(open: (root: string) => Promise<boolean>, choose: () => Promise<void>) {
  const d = toolDialog('最近书库')
  const refresh = () => {
    d.body.replaceChildren()
    const roots = read().recent
    if (!roots.length) d.body.append(element('p', '打开一个文件夹后，它会出现在这里。', 'tool-hint'))
    for (const root of roots) {
      const row = element('div', '', 'tool-row')
      d.button(root, async () => { if (await open(root)) d.dialog.close(); else throw new Error('无法打开书库，请检查目录是否存在且可以访问。当前书库已保留。') }, row)
      d.button('移除记录', () => { const store = read(); store.recent = store.recent.filter(p => p !== root); write(store); refresh() }, row)
      d.body.append(row)
    }
  }
  d.button('打开其他书库…', async () => { d.dialog.close(); await choose() })
  void d.run(refresh)
}
const snapshot = (): Layout => { const s = getState(); return structuredClone({ collapsed: s.collapsed, widths: s.widths, focusMode: s.focusMode, typewriter: s.typewriter }) }
export function openLayouts(apply: () => void) {
  const d = toolDialog('阅读与写作布局'), name = input('布局名称')
  d.body.append(name.wrap)
  const list = element('div'); d.body.append(list)
  const use = (layout: Layout) => { Object.assign(getState(), structuredClone(layout)); saveState(); apply(); d.status.textContent = '布局已应用' }
  d.button('阅读预设', () => use({ collapsed: { sidebar:false, editor:true, preview:false, outline:false, backlink:true }, widths: { sidebar:224, editor:400, outline:210 }, focusMode:false, typewriter:false }))
  d.button('写作预设', () => use({ collapsed: { sidebar:true, editor:false, preview:false, outline:true, backlink:true }, widths: { sidebar:224, editor:520, outline:184 }, focusMode:false, typewriter:true }))
  const validName = () => { const n = name.field.value.trim(); if (!n || n.length>80 || ['__proto__','constructor','prototype'].includes(n)) throw new Error('请输入 1–80 字的布局名称'); return n }
  const refresh = () => {
    list.replaceChildren()
    for (const [key, layout] of Object.entries(read().layouts)) {
      const row = element('div', '', 'tool-row'); row.append(element('span', key))
      d.button('应用', () => use(layout), row)
      d.button('重命名', () => { const n = validName(), store = read(); if (n !== key && Object.hasOwn(store.layouts,n)) throw new Error('该布局名已存在'); delete store.layouts[key]; store.layouts[n] = layout; write(store); refresh() }, row)
      d.button('删除', () => { const store = read(); delete store.layouts[key]; write(store); refresh() }, row)
      list.append(row)
    }
  }
  d.button('保存当前布局', () => { const n = validName(), store=read(); if (Object.hasOwn(store.layouts,n)) throw new Error('名称已存在，请输入新名称'); store.layouts[n]=snapshot(); write(store); refresh(); d.status.textContent='已保存布局' })
  void d.run(refresh)
}
