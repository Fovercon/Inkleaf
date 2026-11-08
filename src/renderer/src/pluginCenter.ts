/** Plugin management workspace; mutations share the runtime and main-process installer. */
import { pluginSnapshot, onPluginStateChange, discoverExternalPlugins, reloadPlugin, uninstallPlugin, type PluginSnapshot } from './pluginRuntime'
import { getCommand } from './commands'
import { escapeHtml as e } from './util'
import { comparePluginVersions, type CatalogState, type CatalogEntry, type PluginDetails, type PluginResult } from '../../shared/plugins'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { calloutMarkdown } from './bundled-callout'

const STATE_LABEL: Record<PluginSnapshot['state'], string> = { registered: '待启用', activating: '启用中', active: '运行中', disabled: '已停用', error: '出错' }
const PERMISSION_LABEL: Record<string, string> = { commands: '提供命令', render: '处理文档预览', model: '使用共用模型连接' }
type View = 'installed' | 'discover' | 'updates'
type DetailTab = 'about' | 'examples' | 'versions'
let subscribed = false, busy = false
let returnFocus: HTMLElement | null = null
let view: View = 'installed', selected = '', tab: DetailTab = 'about'
let catalog: CatalogState = { entries: [], source: 'bundled' }
const overlay = () => document.getElementById('pc-overlay')
const visible = () => overlay()?.classList.contains('visible')
const exampleMd = new MarkdownIt({ html: false }).use(calloutMarkdown)

// Manually installed plugin metadata is untrusted, including the types of optional fields.
function details(raw: PluginDetails): PluginDetails {
  const result: PluginDetails = {}
  for (const key of ['description', 'author', 'category', 'usage', 'minAppVersion'] as const) if (typeof raw[key] === 'string') result[key] = raw[key].slice(0, 12000)
  if (Array.isArray(raw.examples)) result.examples = raw.examples.filter(x => x && typeof x.title === 'string' && typeof x.markdown === 'string').slice(0, 64)
  if (Array.isArray(raw.changelog)) result.changelog = raw.changelog.filter(x => x && typeof x.version === 'string' && typeof x.notes === 'string').slice(0, 64)
  return result
}
// Keep the remote directory compatible with older clients; new built-ins come from this app.
function directory(): (CatalogEntry | PluginSnapshot)[] {
  return [...catalog.entries, ...pluginSnapshot().filter(p => p.bundled && !catalog.entries.some(c => c.id === p.id))]
}
function entry(id: string) { return directory().find(p => p.id === id) }
function installed(id: string) { return pluginSnapshot().find(p => p.id === id) }
function update(p: PluginSnapshot) { const c = entry(p.id); return c && comparePluginVersions(c.version, p.version) === 1 ? c : undefined }
function status(message: string, error = false) {
  const el = document.getElementById('pc-status')
  if (el) { el.textContent = message; el.classList.toggle('error', error) }
}
type FocusTarget = { id?: string; plugin?: string; action?: string; command?: string }
function captureFocus(): FocusTarget {
  const el = document.activeElement as HTMLElement | null
  return { id: el?.id, plugin: el?.closest<HTMLElement>('[data-id]')?.dataset.id, action: el?.dataset.action, command: el?.dataset.cmd }
}
function restoreFocus(target: FocusTarget) {
  if (!visible()) return
  const button = [...(overlay()?.querySelectorAll<HTMLElement>('button, input, select') ?? [])].find(el =>
    !(el as HTMLButtonElement).disabled && (target.id ? el.id === target.id : target.plugin && el.closest<HTMLElement>('[data-id]')?.dataset.id === target.plugin &&
      (target.action ? el.dataset.action === target.action : target.command && el.dataset.cmd === target.command)))
  ;(button ?? document.querySelector<HTMLElement>('.pc-close'))?.focus()
}
async function action(message: string, work: () => Promise<string | void>): Promise<void> {
  if (busy) return
  const focus = captureFocus()
  busy = true; status(message); renderPlugins()
  try { status(await work() ?? '') }
  catch (err) { status(err instanceof Error ? err.message : String(err), true) }
  finally { busy = false; renderPlugins(); restoreFocus(focus) }
}
function checkActivation(id: string, ok: boolean) {
  if (!ok) throw Error(pluginSnapshot().find(p => p.id === id)?.message ?? '插件未能启用，请重试')
}
export function openPluginCenter(): void {
  if (!overlay()) return
  if (!visible()) returnFocus = document.activeElement as HTMLElement | null
  if (!subscribed) { onPluginStateChange(renderPlugins); subscribed = true }
  overlay()!.classList.add('visible'); renderPlugins()
  document.querySelector<HTMLElement>('.pc-close')?.focus()
  void action('正在读取插件…', async () => {
    await discoverExternalPlugins()
    catalog = await window.mdr.pluginsCatalog()
    updateCategories()
    return catalog.warning ?? '启停选择自动保存。安装前可在详情中了解用法与权限。'
  })
}
export function closePluginCenter(): void { overlay()?.classList.remove('visible'); if (returnFocus?.isConnected) returnFocus.focus() }
function updateCategories() {
  const select = document.getElementById('pc-category') as HTMLSelectElement
  const previous = select.value
  const categories = [...new Set([...catalog.entries, ...pluginSnapshot()].map(p => details(p).category || '其他'))].sort()
  select.replaceChildren(new Option('全部分类', ''), ...categories.map(x => new Option(x, x)))
  if (categories.includes(previous)) select.value = previous
}
function renderPlugins(): void {
  const host = document.getElementById('pc-list')
  if (!host) return
  const focus = captureFocus(), focusedInList = host.contains(document.activeElement), scroll = host.scrollTop
  const plugins = pluginSnapshot().sort((a, b) => Number(b.bundled) - Number(a.bundled) || a.id.localeCompare(b.id))
  const source: (PluginSnapshot | CatalogEntry)[] = view === 'discover' ? directory() : view === 'updates' ? plugins.filter(p => update(p)) : plugins
  const query = (document.getElementById('pc-search') as HTMLInputElement).value.trim().toLocaleLowerCase()
  const category = (document.getElementById('pc-category') as HTMLSelectElement).value
  const filtered = source.filter(p => {
    const d = details(p), c = entry(p.id)
    return (!query || [p.name, p.id, d.description, d.author, c?.description, c?.author].join(' ').toLocaleLowerCase().includes(query)) &&
      (!category || (d.category || c?.category || '其他') === category)
  })
  if (!filtered.some(p => p.id === selected)) { selected = filtered[0]?.id ?? ''; tab = 'about' }
  host.replaceChildren(...filtered.map(p => card(installed(p.id) ?? p)))
  if (!filtered.length) {
    const empty = document.createElement('div'); empty.className = 'pc-empty'
    empty.textContent = query || category ? '没有匹配的插件，试试其他关键词或分类。' : view === 'updates' ? '暂无可用更新。可点击「检查更新」获取最新官方目录；其他插件可从详情页导入新版。' : '还没有插件。可以浏览「发现插件」或从文件夹安装。'
    host.appendChild(empty)
  }
  host.scrollTop = scroll; host.setAttribute('aria-busy', String(busy))
  document.getElementById('pc-summary')!.textContent = `${filtered.length} 个插件${view === 'installed' ? ` · ${plugins.filter(p => p.state === 'active').length} 个运行中` : ''}`
  for (const [key, count] of [['installed', plugins.length], ['discover', directory().length], ['updates', plugins.filter(p => update(p)).length]] as const) document.getElementById('pc-count-' + key)!.textContent = String(count)
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(btn => { btn.classList.toggle('selected', btn.dataset.view === view); btn.setAttribute('aria-pressed', String(btn.dataset.view === view)) })
  document.querySelectorAll<HTMLButtonElement>('.pc-footer button').forEach(btn => { btn.disabled = busy })
  renderDetail()
  if (focusedInList) restoreFocus(focus)
}
function permissionHtml(permissions: string[]) { return permissions.length ? permissions.map(p => `<span class="pc-perm">${e(PERMISSION_LABEL[p] ?? p)}</span>`).join('') : '<span class="pc-perm none">无需额外权限</span>' }
function card(p: PluginSnapshot | CatalogEntry): HTMLElement {
  const actual = installed(p.id), c = entry(p.id), d = details(p)
  const el = document.createElement('div')
  el.className = 'pc-card' + (actual?.state === 'disabled' ? ' off' : '') + (selected === p.id ? ' selected' : '')
  el.dataset.id = p.id
  const lock = busy ? 'disabled' : ''
  const running = actual?.state === 'active' || actual?.state === 'activating'
  const unavailable = busy || !actual || ['disabled', 'error', 'activating'].includes(actual.state)
  el.innerHTML = `<div class="pc-head"><div class="pc-title"><button class="pc-name" data-action="details" aria-label="查看${e(p.name)}详情">${e(p.name)}</button><span class="pc-src">${p.bundled ? '内置' : '外部'}</span>
    ${actual ? `<span class="pc-state ${actual.state}">${STATE_LABEL[actual.state]}</span>` : ''}</div></div>
    <div class="pc-meta">${e(p.id)} · v${e(p.version)}${actual && update(actual) ? ` <span class="pc-update-badge">可更新至 ${e(c!.version)}</span>` : ''}</div>
    <div class="pc-desc">${e(d.description || c?.description || '此插件暂未提供说明。')}</div>
    ${actual?.message ? `<div class="pc-error">${e(actual.message)}</div>` : ''}
    <div class="pc-perms">${permissionHtml(p.permissions)}</div>
    <div class="pc-actions">${actual ? `<button class="pc-btn" data-action="toggle" ${lock}>${running ? '停用' : actual.state === 'error' ? '重试启用' : '启用'}</button>${actual.bundled ? '' : `<button class="pc-btn" data-action="reload" ${lock}>重新加载</button><button class="pc-btn danger" data-action="uninstall" ${lock}>卸载</button>`}` : `<button class="pc-btn primary" data-action="catalog" ${lock}>安装</button>`}</div>
    ${actual?.commands.length ? `<div class="pc-cmds">${actual.commands.map(cmd => `<button class="pc-cmd" data-cmd="${e(cmd.id)}" ${unavailable ? 'disabled' : ''}>▸ ${e(cmd.title)}</button>`).join('')}</div>` : ''}`
  el.querySelector('[data-action="details"]')?.addEventListener('click', () => { selected = p.id; tab = 'about'; renderPlugins(); restoreFocus({ plugin: p.id, action: 'details' }) })
  el.querySelector('[data-action="toggle"]')?.addEventListener('click', () => void action(`正在${running ? '停用' : '启用'}「${p.name}」…`, async () => {
    const current = installed(p.id)
    if (!current || !window.ink) throw Error('找不到插件，请刷新重试')
    if (['active', 'activating'].includes(current.state)) { window.ink.disable(p.id); return `已停用「${p.name}」，下次打开墨页时也会保持停用。` }
    checkActivation(p.id, await window.ink.enable(p.id)); return `已启用「${p.name}」。`
  }))
  el.querySelector('[data-action="reload"]')?.addEventListener('click', () => void action('正在重新加载…', async () => { checkActivation(p.id, await reloadPlugin(p.id)); return `已重新加载「${p.name}」${installed(p.id)?.state === 'disabled' ? '，仍保持停用' : ''}。` }))
  el.querySelector('[data-action="uninstall"]')?.addEventListener('click', () => void action('等待确认卸载…', async () => {
    if (!await window.mdr.confirm({ title: '卸载插件', message: `将「${p.name}」移到废纸篓吗？`, okLabel: '卸载' })) return '已取消卸载。'
    await uninstallPlugin(p.id); return `已卸载「${p.name}」，文件已移到废纸篓。`
  }))
  el.querySelector('[data-action="catalog"]')?.addEventListener('click', () => void installCatalog(p.id))
  el.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach(btn => btn.addEventListener('click', () => void action('正在执行命令…', async () => {
    const command = getCommand(btn.dataset.cmd ?? '')
    if (!command || command.when?.() === false) throw Error('命令暂不可用，请先启用插件')
    await command.run(); checkActivation(p.id, installed(p.id)?.state === 'active'); closePluginCenter()
  })))
  return el
}
async function finishInstall(result: PluginResult, upgrading: boolean): Promise<string> {
  if (result.canceled) return '已取消。'
  if (!result.ok) throw Error(result.error ?? '安装失败')
  try { await discoverExternalPlugins() } catch (err) { throw Error(`文件已${upgrading ? '更新' : '安装'}，但列表刷新失败，请点击「刷新」：${String(err)}`) }
  const p = result.id ? installed(result.id) : undefined
  if (p?.state === 'error') throw Error(`文件已更新，但插件未能启动：${p.message}。可停用后从本地修复，或安装后续版本。`)
  updateCategories()
  return upgrading ? `已更新「${p?.name ?? result.id}」，保留原来的启停选择。` : `已安装「${p?.name ?? result.id}」。查看权限后，点击「启用」即可使用。`
}
async function installCatalog(id: string) {
  const c = entry(id)
  if (!c || c.bundled) return
  return action('正在准备插件，请确认版本与权限…', async () => finishInstall(await window.mdr.pluginsInstallCatalog(id, c.version), !!installed(id)))
}
function renderDetail() {
  const host = document.getElementById('pc-detail')!
  const oldScroll = host.scrollTop
  const p = installed(selected), c = entry(selected), info = p ?? c
  if (!info) { host.innerHTML = '<div class="pc-detail-empty"><span>✦</span><p>选择一个插件，了解它能做什么。</p></div>'; return }
  // Never describe an installed older version as if it already has catalog-only features.
  const d = details(p && p.version !== c?.version ? p : { ...c, ...p, description: p?.description || c?.description })
  const examples = d.examples ?? []
  const versions = [...new Map([...(p && update(p) ? details(c!).changelog ?? [] : []), ...(d.changelog ?? [])].map(item => [item.version, item])).values()]
  host.dataset.id = info.id
  host.innerHTML = `<div class="pc-detail-head"><span class="pc-detail-icon">${info.bundled ? '❖' : '✦'}</span><h2>${e(info.name)}</h2><p>${e(d.description ?? '')}</p><div class="pc-meta">v${e(info.version)} · ${e(d.author || '作者未提供')} · ${e(d.category || '其他')}</div>
    <div class="pc-perms">${permissionHtml(info.permissions)}</div>
    ${d.minAppVersion ? `<p class="pc-meta">需要墨页 ${e(d.minAppVersion)} 或更新版本</p>` : ''}
    <div class="pc-detail-actions">${p && !p.bundled ? `<button class="pc-btn" id="pc-local-update" ${busy ? 'disabled' : ''}>从文件夹更新…</button>` : ''}${p && update(p) && !p.bundled ? `<button class="pc-btn primary" id="pc-upgrade" ${busy ? 'disabled' : ''}>更新至 ${e(c!.version)}</button>` : !p && !info.bundled ? `<button class="pc-btn primary" id="pc-upgrade" ${busy ? 'disabled' : ''}>安装插件</button>` : ''}</div>
    ${p?.bundled ? '<p class="pc-meta">内置插件随墨页更新。</p>' : ''}${p && update(p) ? `<p class="pc-update-badge">目录最新版本：${e(c!.version)}${p.bundled ? '，请更新墨页软件获取。' : ''}</p>` : ''}
    ${p && !c && !p.bundled ? '<p class="pc-meta">此插件不在官方目录中，请从作者处获取新版。</p>' : ''}</div>
    <div class="pc-detail-tabs" role="tablist" aria-label="插件详情栏目">${([['about', '介绍'], ['examples', '使用示例'], ['versions', '版本记录']] as const).map(([key, label]) => `<button id="pc-tab-${key}" role="tab" aria-selected="${tab === key}" aria-controls="pc-detail-content" tabindex="${tab === key ? 0 : -1}" data-tab="${key}">${label}</button>`).join('')}</div>
    <div id="pc-detail-content" role="tabpanel" aria-labelledby="pc-tab-${tab}">${tab === 'about' ? `<h3>如何使用</h3><p class="pc-usage">${e(d.usage || '作者尚未提供使用说明。启用后可使用插件提供的预览扩展或命令。')}</p><h3>权限说明</h3><p>${info.permissions.includes('render') ? '处理文档预览：插件能接收渲染后的文档内容并返回显示结果。' : ''}${info.permissions.includes('commands') ? ' 提供命令：插件可以向命令面板添加操作。' : ''}${info.permissions.length ? '' : '此插件未声明额外权限。'}</p><p class="pc-meta">外部插件在隔离环境运行。安装完成后由你选择是否启用。</p>` : tab === 'versions' ? versions.length ? versions.map(v => `<article class="pc-version"><h3>v${e(v.version)}</h3><p>${e(v.notes)}</p></article>`).join('') : '<p class="pc-empty">作者尚未提供版本记录。</p>' : examples.length ? examples.map((x, index) => `<article class="pc-example"><div><h3>${e(x.title)}</h3><button class="pc-btn" data-copy="${index}">复制写法</button></div><pre><code>${e(x.markdown.slice(0, 12000))}</code></pre><div class="pc-example-preview md-preview">${DOMPurify.sanitize(exampleMd.render(x.markdown.slice(0, 12000)), { ADD_ATTR: ['data-callout-title'], FORBID_TAGS: ['img', 'iframe', 'video', 'audio', 'source', 'style'] })}</div></article>`).join('') : '<p class="pc-empty">此插件无需特殊语法，启用后自动生效。作者未提供可复制示例。</p>'}</div>`
  host.scrollTop = oldScroll
  host.querySelectorAll<HTMLAnchorElement>('.pc-example-preview a').forEach(a => a.addEventListener('click', event => event.preventDefault()))
  host.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => { tab = btn.dataset.tab as DetailTab; renderDetail(); document.getElementById('pc-tab-' + tab)?.focus() })
    btn.addEventListener('keydown', event => {
      const tabs: DetailTab[] = ['about', 'examples', 'versions']; let index = tabs.indexOf(tab)
      if (event.key === 'ArrowRight') index = (index + 1) % 3
      else if (event.key === 'ArrowLeft') index = (index + 2) % 3
      else if (event.key === 'Home') index = 0
      else if (event.key === 'End') index = 2
      else return
      event.preventDefault(); tab = tabs[index]; renderDetail(); document.getElementById('pc-tab-' + tab)?.focus()
    })
  })
  host.querySelector('#pc-upgrade')?.addEventListener('click', () => void installCatalog(info.id))
  host.querySelector('#pc-local-update')?.addEventListener('click', () => void action('请选择新版插件文件夹…', async () => finishInstall(await window.mdr.pluginsUpdateLocal(info.id), true)))
  host.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(examples[Number(btn.dataset.copy)].markdown); status('写法已复制，可粘贴到文档中。') }
    catch { status('无法写入剪贴板，可选中示例手动复制。', true) }
  }))
}
export function setupPluginCenter(): void {
  document.getElementById('btn-plugins')?.addEventListener('click', openPluginCenter)
  document.querySelector('.pc-close')?.addEventListener('click', closePluginCenter)
  overlay()?.addEventListener('click', event => { if (event.target === event.currentTarget) closePluginCenter() })
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(btn => btn.addEventListener('click', () => { view = btn.dataset.view as View; selected = ''; tab = 'about'; renderPlugins() }))
  document.getElementById('pc-search')?.addEventListener('input', renderPlugins)
  document.getElementById('pc-category')?.addEventListener('change', renderPlugins)
  document.addEventListener('keydown', event => {
    if (!visible()) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closePluginCenter() }
    if (event.key === 'Tab') {
      const controls = [...(overlay()?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled)') ?? [])]
      const index = controls.indexOf(document.activeElement as HTMLElement)
      if (index === -1 || (event.shiftKey ? index === 0 : index === controls.length - 1)) { event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus() }
    }
  }, true)
  document.getElementById('pc-reveal')?.addEventListener('click', () => void action('正在打开插件文件夹…', async () => { await window.mdr.pluginsReveal(); return '已打开插件文件夹。手动修改文件后，点击「重新加载」。' }))
  document.getElementById('pc-install')?.addEventListener('click', () => void action('请选择插件文件夹…', async () => finishInstall(await window.mdr.pluginsInstall(), false)))
  document.getElementById('pc-refresh')?.addEventListener('click', () => void action('正在刷新…', async () => { await discoverExternalPlugins(); catalog = await window.mdr.pluginsCatalog(); updateCategories(); return catalog.warning ?? '插件列表已刷新。' }))
  document.getElementById('pc-check-updates')?.addEventListener('click', () => void action('正在检查官方插件目录…', async () => {
    catalog = await window.mdr.pluginsCheckUpdates(); updateCategories()
    const message = document.getElementById('pc-hint')!
    message.textContent = catalog.checkedAt ? `目录检查时间：${new Date(catalog.checkedAt).toLocaleString()} · ${catalog.source === 'online' ? '在线官方目录' : '本地目录'}` : '正在使用随软件附带的官方目录。'
    if (catalog.warning) throw Error(catalog.warning)
    return `检查完成，${pluginSnapshot().filter(p => update(p)).length} 个插件有新版本。外部插件按需更新。`
  }))
}
