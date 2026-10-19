/** 插件中心对话框：只读快照渲染 + 生命周期操作，状态经订阅实时刷新。 */
import { pluginSnapshot, onPluginStateChange, discoverExternalPlugins, type PluginSnapshot } from './pluginRuntime'
import { runCommand } from './commands'
import { escapeHtml } from './util'

const STATE_LABEL: Record<PluginSnapshot['state'], string> = {
  registered: '待激活',
  activating: '激活中',
  active: '运行中',
  disabled: '已停用',
  error: '出错',
}

let unsubscribe: (() => void) | null = null

export function openPluginCenter(): void {
  const overlay = document.getElementById('pc-overlay')
  if (!overlay) return
  if (!unsubscribe) unsubscribe = onPluginStateChange(renderPlugins)
  overlay.classList.add('visible')
  renderPlugins()
}

export function closePluginCenter(): void {
  document.getElementById('pc-overlay')?.classList.remove('visible')
}

function renderPlugins(): void {
  const host = document.getElementById('pc-list')
  if (!host) return
  const plugins = pluginSnapshot().sort((a, b) => Number(b.bundled) - Number(a.bundled) || a.id.localeCompare(b.id))
  host.innerHTML = ''
  if (!plugins.length) {
    const empty = document.createElement('div')
    empty.className = 'pc-empty'
    empty.textContent = '还没有插件。点击下方「从文件夹安装…」，或先打开插件文件夹放一个进去。'
    host.appendChild(empty)
    return
  }
  for (const p of plugins) host.appendChild(card(p))
}

function card(p: PluginSnapshot): HTMLElement {
  const el = document.createElement('div')
  el.className = 'pc-card' + (p.state === 'disabled' || p.state === 'error' ? ' off' : '')
  el.dataset.id = p.id
  const perms = p.permissions.length ? p.permissions.map((x) => `<span class="pc-perm">${escapeHtml(x)}</span>`).join('') : '<span class="pc-perm none">无权限</span>'
  const meta = [`${escapeHtml(p.id)}${p.version ? `@${escapeHtml(p.version)}` : ''}`].join('')
  const commands = p.commands.map((c) =>
    `<button class="pc-cmd" data-cmd="${escapeHtml(c.id)}">▸ ${escapeHtml(c.title)}</button>`).join('')
  const source = p.bundled ? '<span class="pc-src">内置</span>' : '<span class="pc-src ext">外部</span>'
  const running = p.state === 'active' || p.state === 'activating'
  el.innerHTML =
    `<div class="pc-head">
       <div class="pc-title">
         <span class="pc-name">${escapeHtml(p.name)}</span>
         ${source}
         <span class="pc-state ${p.state}">${STATE_LABEL[p.state]}</span>
       </div>
       <div class="pc-actions">
         <button class="pc-btn" data-action="toggle">${running ? '停用' : '启用'}</button>
         ${p.bundled ? '' : '<button class="pc-btn" data-action="reload">重新加载</button>'}
         ${p.bundled ? '' : '<button class="pc-btn danger" data-action="uninstall">卸载</button>'}
       </div>
     </div>
     <div class="pc-meta">${meta}</div>
     ${p.description ? `<div class="pc-desc">${escapeHtml(p.description)}</div>` : ''}
     ${p.state === 'error' && p.message ? `<div class="pc-error">${escapeHtml(p.message)}</div>` : ''}
     <div class="pc-perms">${perms}</div>
     ${commands ? `<div class="pc-cmds">${commands}</div>` : ''}`
  el.querySelector('[data-action="toggle"]')?.addEventListener('click', () => {
    // read live state at click time; this card may be stale after a re-render
    const live = pluginSnapshot().find((x) => x.id === p.id)
    if (!live) return
    if (live.state === 'active' || live.state === 'activating') window.ink?.disable(p.id)
    else window.ink?.enable(p.id)
    renderPlugins()
  })
  el.querySelector('[data-action="reload"]')?.addEventListener('click', async () => {
    window.ink?.disable(p.id)
    await discoverExternalPlugins()
    window.ink?.enable(p.id)
    renderPlugins()
  })
  el.querySelector('[data-action="uninstall"]')?.addEventListener('click', async () => {
    const ok = await window.mdr.confirm({ title: '卸载插件', message: `将「${p.name}」移到废纸篓吗？`, okLabel: '卸载' })
    if (!ok) return
    window.ink?.disable(p.id)
    const r = await window.mdr.pluginsUninstall(p.id)
    if (!r.ok) void window.mdr.confirm({ title: '卸载失败', message: r.error ?? '未知错误', okLabel: '知道了' })
    await discoverExternalPlugins()
    renderPlugins()
  })
  el.querySelectorAll('.pc-cmd').forEach((btn) =>
    btn.addEventListener('click', () => { closePluginCenter(); runCommand((btn as HTMLElement).dataset.cmd ?? '') }))
  return el
}

export function setupPluginCenter(): void {
  document.getElementById('btn-plugins')?.addEventListener('click', openPluginCenter)
  document.querySelector('#pc-overlay .pc-close')?.addEventListener('click', closePluginCenter)
  document.getElementById('pc-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePluginCenter()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('pc-overlay')?.classList.contains('visible')) closePluginCenter()
  })
  document.getElementById('pc-reveal')?.addEventListener('click', () => void window.mdr.pluginsReveal())
  document.getElementById('pc-install')?.addEventListener('click', async () => {
    const r = await window.mdr.pluginsInstall()
    if (!r.ok && r.error !== '已取消') {
      void window.mdr.confirm({ title: '安装失败', message: r.error ?? '未知错误', okLabel: '知道了' })
    }
    await discoverExternalPlugins()
    renderPlugins()
  })
  document.getElementById('pc-refresh')?.addEventListener('click', async () => {
    await discoverExternalPlugins()
    renderPlugins()
  })
}
