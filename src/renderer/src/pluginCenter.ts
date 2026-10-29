/** Plugin center: all mutations go through the shared lifecycle and host APIs. */
import { pluginSnapshot, onPluginStateChange, discoverExternalPlugins, reloadPlugin, uninstallPlugin, type PluginSnapshot } from './pluginRuntime'
import { getCommand } from './commands'
import { escapeHtml } from './util'

const STATE_LABEL: Record<PluginSnapshot['state'], string> = {
  registered: '待启用', activating: '启用中', active: '运行中', disabled: '已停用', error: '出错',
}
const PERMISSION_LABEL: Record<string, string> = { commands: '提供命令', render: '处理文档预览' }
let subscribed = false
let busy = false
let returnFocus: HTMLElement | null = null
const overlay = () => document.getElementById('pc-overlay')
const visible = () => overlay()?.classList.contains('visible')

type FocusTarget = { id?: string; plugin?: string; action?: string; command?: string }
function captureFocus(): FocusTarget {
  const el = document.activeElement as HTMLElement | null
  return { id: el?.id, plugin: el?.closest<HTMLElement>('.pc-card')?.dataset.id, action: el?.dataset.action, command: el?.dataset.cmd }
}
function restoreFocus(target: FocusTarget) {
  if (!visible()) return
  const button = [...(overlay()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(el =>
    !el.disabled && (target.id ? el.id === target.id : target.plugin && el.closest<HTMLElement>('.pc-card')?.dataset.id === target.plugin &&
      (target.action ? el.dataset.action === target.action : target.command && el.dataset.cmd === target.command)))
  ;(button ?? document.querySelector<HTMLElement>('#pc-overlay .pc-close'))?.focus()
}
function status(message: string, error = false) {
  const el = document.getElementById('pc-status')
  if (!el) return
  el.textContent = message
  el.classList.toggle('error', error)
}
async function action(message: string, work: () => Promise<string | void>): Promise<void> {
  if (busy) return
  const focus = captureFocus()
  busy = true
  status(message)
  renderPlugins()
  try { status(await work() ?? '') }
  catch (err) { status(err instanceof Error ? err.message : String(err), true) }
  finally { busy = false; renderPlugins(); restoreFocus(focus) }
}
function checkActivation(id: string, ok: boolean) {
  if (!ok) throw new Error(pluginSnapshot().find(p => p.id === id)?.message ?? '插件未能启用，请重试')
}

export function openPluginCenter(): void {
  if (!overlay()) return
  if (!visible()) returnFocus = document.activeElement as HTMLElement | null
  if (!subscribed) { onPluginStateChange(renderPlugins); subscribed = true }
  overlay()!.classList.add('visible')
  renderPlugins()
  document.querySelector<HTMLElement>('#pc-overlay .pc-close')?.focus()
  void action('正在检查插件…', async () => { await discoverExternalPlugins(); return '启停选择会自动保存，并在下次打开墨页时恢复。' })
}
export function closePluginCenter(): void {
  overlay()?.classList.remove('visible')
  if (returnFocus?.isConnected) returnFocus.focus()
}
function renderPlugins(): void {
  const host = document.getElementById('pc-list')
  if (!host) return
  const focus = captureFocus()
  const focusedInList = host.contains(document.activeElement)
  const scroll = host.scrollTop
  const plugins = pluginSnapshot().sort((a, b) => Number(b.bundled) - Number(a.bundled) || a.id.localeCompare(b.id))
  host.replaceChildren(...plugins.map(card))
  if (!plugins.length) {
    const empty = document.createElement('div')
    empty.className = 'pc-empty'
    empty.textContent = '还没有插件。点击「从文件夹安装…」，选择包含 ink.plugin.json 的插件文件夹。'
    host.appendChild(empty)
  }
  host.scrollTop = scroll
  const summary = document.getElementById('pc-summary')
  if (summary) summary.textContent = `${plugins.length} 个插件 · ${plugins.filter(p => p.state === 'active').length} 个运行中`
  host.setAttribute('aria-busy', String(busy))
  document.querySelectorAll<HTMLButtonElement>('.pc-footer button').forEach(btn => { btn.disabled = busy })
  if (focusedInList) restoreFocus(focus)
}
function card(p: PluginSnapshot): HTMLElement {
  const el = document.createElement('div')
  el.className = 'pc-card' + (p.state === 'disabled' ? ' off' : '')
  el.dataset.id = p.id
  const permissions = p.permissions.length ? p.permissions.map(x => `<span class="pc-perm" title="${escapeHtml(x)}">${escapeHtml(PERMISSION_LABEL[x] ?? x)}</span>`).join('') : '<span class="pc-perm none">无需额外权限</span>'
  const unavailable = busy || p.state === 'disabled' || p.state === 'error' || p.state === 'activating'
  const commands = p.commands.map(c => `<button class="pc-cmd" data-cmd="${escapeHtml(c.id)}" ${unavailable ? 'disabled' : ''}>▸ ${escapeHtml(c.title)}</button>`).join('')
  const running = p.state === 'active' || p.state === 'activating'
  const locked = busy ? 'disabled' : ''
  el.innerHTML = `<div class="pc-head">
    <div class="pc-title"><span class="pc-name">${escapeHtml(p.name)}</span><span class="pc-src ${p.bundled ? '' : 'ext'}">${p.bundled ? '内置' : '外部'}</span><span class="pc-state ${p.state}">${STATE_LABEL[p.state]}</span></div>
    <div class="pc-actions">
      <button class="pc-btn" data-action="toggle" ${locked}>${running ? '停用' : p.state === 'error' ? '重试启用' : '启用'}</button>
      ${p.bundled ? '' : `<button class="pc-btn" data-action="reload" ${locked}>重新加载</button><button class="pc-btn danger" data-action="uninstall" ${locked}>卸载</button>`}
    </div></div>
    <div class="pc-meta">${escapeHtml(p.id)}${p.version ? ` · v${escapeHtml(p.version)}` : ''}</div>
    ${p.description ? `<div class="pc-desc">${escapeHtml(p.description)}</div>` : ''}
    ${p.state === 'error' && p.message ? `<div class="pc-error">${escapeHtml(p.message)}</div>` : ''}
    <div class="pc-perms">${permissions}</div>${commands ? `<div class="pc-cmds">${commands}</div>` : ''}`
  el.querySelector('[data-action="toggle"]')?.addEventListener('click', () => void action(`正在${running ? '停用' : '启用'}「${p.name}」…`, async () => {
    const current = pluginSnapshot().find(x => x.id === p.id)
    if (!current || !window.ink) throw new Error('找不到插件，请刷新后重试')
    if (current.state === 'active' || current.state === 'activating') {
      window.ink.disable(p.id)
      return `已停用「${p.name}」，下次打开墨页时也会保持停用。`
    }
    checkActivation(p.id, await window.ink.enable(p.id))
    return `已启用「${p.name}」。`
  }))
  el.querySelector('[data-action="reload"]')?.addEventListener('click', () => void action(`正在重新加载「${p.name}」…`, async () => {
    checkActivation(p.id, await reloadPlugin(p.id))
    return pluginSnapshot().find(x => x.id === p.id)?.state === 'disabled' ? `已刷新「${p.name}」，仍保持停用。` : `已重新加载「${p.name}」。`
  }))
  el.querySelector('[data-action="uninstall"]')?.addEventListener('click', () => void action(`等待确认卸载「${p.name}」…`, async () => {
    if (!await window.mdr.confirm({ title: '卸载插件', message: `将「${p.name}」移到废纸篓吗？`, okLabel: '卸载' })) return '已取消卸载。'
    await uninstallPlugin(p.id)
    return `已卸载「${p.name}」，文件已移到废纸篓。`
  }))
  el.querySelectorAll<HTMLButtonElement>('.pc-cmd').forEach(btn => btn.addEventListener('click', () => void action('正在执行插件命令…', async () => {
    const command = getCommand(btn.dataset.cmd ?? '')
    if (!command || command.when?.() === false) throw new Error('命令暂不可用，请先启用插件')
    await command.run()
    checkActivation(p.id, pluginSnapshot().find(x => x.id === p.id)?.state === 'active')
    closePluginCenter()
  })))
  return el
}
export function setupPluginCenter(): void {
  document.getElementById('btn-plugins')?.addEventListener('click', openPluginCenter)
  document.querySelector('#pc-overlay .pc-close')?.addEventListener('click', closePluginCenter)
  overlay()?.addEventListener('click', e => { if (e.target === e.currentTarget) closePluginCenter() })
  document.addEventListener('keydown', e => {
    if (!visible()) return
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closePluginCenter() }
    if (e.key === 'Tab') {
      const buttons = [...(overlay()?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      if (index === -1 || (e.shiftKey ? index === 0 : index === buttons.length - 1)) {
        e.preventDefault()
        ;(e.shiftKey ? buttons.at(-1) : buttons[0])?.focus()
      }
    }
  }, true)
  document.getElementById('pc-reveal')?.addEventListener('click', () => void action('正在打开插件文件夹…', async () => {
    await window.mdr.pluginsReveal(); return '已打开插件文件夹。手动修改文件后，点击「重新加载」。'
  }))
  document.getElementById('pc-install')?.addEventListener('click', () => void action('请选择要安装的插件文件夹…', async () => {
    const result = await window.mdr.pluginsInstall()
    if (result.canceled) return '已取消安装。'
    if (!result.ok) throw new Error(result.error ?? '安装失败，请检查插件文件夹')
    try { await discoverExternalPlugins() }
    catch (err) { throw new Error(`文件已安装，但列表刷新失败，请点击「刷新」重试：${String(err)}`) }
    const name = pluginSnapshot().find(p => p.id === result.id)?.name ?? result.id ?? '插件'
    return `已安装「${name}」。查看权限后，点击「启用」即可使用。`
  }))
  document.getElementById('pc-refresh')?.addEventListener('click', () => void action('正在刷新插件列表…', async () => {
    await discoverExternalPlugins(); return '插件列表已刷新。'
  }))
}
