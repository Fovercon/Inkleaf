import { formatShortcut } from './platform'

const hints: Record<string, string> = {
  'btn-home': '回到首页，查看最近打开的文档',
  'btn-open-folder': '打开一个文件夹，将其中的 Markdown 文件作为书库浏览',
  'btn-open-file': '打开单篇 Markdown 文档',
  'btn-new-file': '新建一篇 Markdown 文档',
  'empty-open-folder': '打开文件夹，开始浏览书库中的 Markdown 文档',
  'empty-open-file': '打开单篇 Markdown 文档',
  'library-open-file': '打开单篇 Markdown 文档',
  'library-new-file': '在当前书库中新建一篇文档',
  'empty-switch-library': '选择最近使用的书库',
  'home-switch-library': '选择最近使用的书库',
  'btn-theme': '切换界面配色：跟随系统、暖白、羊皮纸、护眼绿、深色',
  'btn-tools': '创作与知识工具：历史恢复、文档属性、搜索替换、布局、模板与每日笔记',
  'btn-plugins': '打开插件中心，浏览、安装和管理插件',
  'library-switch': '切换书库，或重新打开最近使用的书库',
  'sidebar-expand': '展开书库栏，浏览文件与标签',
  'sidebar-collapse': '收起书库栏，为正文留出更多空间',
  'tab-files': '浏览当前书库中的全部文件和文件夹',
  'tab-recent': '查看最近打开的文档',
  'tab-tags': '按文档标签浏览当前书库',
  'back-top': '回到当前文档的顶部',
  'pc-reveal': '在系统文件管理器中打开外部插件的安装目录',
  'pc-install': '从包含 ink.plugin.json 的本地文件夹安装插件',
  'pc-refresh': '重新扫描已安装插件并刷新本地目录',
  'pc-check-updates': '联网检查官方插件目录，查找可用更新',
  'pc-local-update': '选择同一插件的新版文件夹，确认版本和权限后升级',
}
const panels: Record<string, string> = { 'btn-toggle-sidebar': '书库栏', 'btn-toggle-editor': '编辑面板', 'btn-toggle-preview': '阅读预览', 'btn-toggle-outline': '文档大纲' }
/** Read at display time so toggles, update status and newly inserted buttons stay accurate. */
function label(target: HTMLElement, heldTitle?: string): string {
  const panel = panels[target.id]
  const text = target.dataset.tooltip || (panel ? `${target.getAttribute('aria-pressed') === 'true' ? '收起' : '展开'}${panel}` : hints[target.id]) || target.getAttribute('title') || heldTitle || target.getAttribute('aria-label') || target.textContent?.trim().replace(/\s+/g, ' ') || ''
  const shortcut = target.dataset.shortcut || target.querySelector<HTMLElement>('kbd[data-shortcut]')?.dataset.shortcut
  const concise = text.length > 300 ? text.slice(0, 299) + '…' : text
  return concise && shortcut ? `${concise.replace(/\s+\([^)]*\)$/, '')}（${formatShortcut(shortcut)}）` : concise
}

/** One delegated tooltip covers static controls, dynamic dialogs and icon buttons. */
export function setupTooltips(): void {
  const tip = document.createElement('div')
  tip.id = 'ink-button-tooltip'; tip.className = 'ink-button-tooltip'
  tip.setAttribute('role', 'tooltip'); tip.setAttribute('popover', 'manual')
  document.body.append(tip)
  let target: HTMLElement | null = null, timer: ReturnType<typeof setTimeout> | undefined
  let heldTitle: string | undefined
  const observer = new MutationObserver(() => {
    if (!target?.isConnected || !target.getClientRects().length || target.closest('[hidden], [inert]')) { hide(); return }
    if (target.hasAttribute('title')) { heldTitle = target.title; target.removeAttribute('title') }
    if (tip.matches(':popover-open')) { const text = label(target, heldTitle); if (tip.textContent !== text) tip.textContent = text; position() }
  })
  function position() {
    if (!target) return
    const r = target.getBoundingClientRect()
    const box = tip.getBoundingClientRect(), gap = 8
    const top = r.bottom + gap + box.height <= innerHeight - gap ? r.bottom + gap : Math.max(gap, r.top - box.height - gap)
    tip.style.left = `${Math.max(gap, Math.min(innerWidth - box.width - gap, r.left + (r.width - box.width) / 2))}px`
    tip.style.top = `${top}px`
  }
  function hide() {
    clearTimeout(timer); timer = undefined; observer.disconnect()
    if (target) {
      const ids = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== tip.id)
      if (ids.length) target.setAttribute('aria-describedby', ids.join(' ')); else target.removeAttribute('aria-describedby')
      if (heldTitle !== undefined && !target.hasAttribute('title')) target.title = heldTitle
    }
    target = null; heldTitle = undefined
    if (tip.matches(':popover-open')) tip.hidePopover()
    if (!tip.isConnected) document.body.append(tip)
  }
  function show(next: HTMLElement, delay: number) {
    if (target === next) return
    hide(); target = next
    heldTitle = next.getAttribute('title') ?? undefined
    // Suppress Chromium's second, slower title bubble for the same control.
    if (heldTitle !== undefined) next.removeAttribute('title')
    timer = setTimeout(() => {
      if (!target?.isConnected || !target.getClientRects().length || !label(target, heldTitle)) { hide(); return }
      const parent = target.closest('dialog[open]') ?? document.body
      if (tip.parentElement !== parent) parent.append(tip)
      tip.textContent = label(target, heldTitle)
      const ids = new Set((target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)); ids.add(tip.id)
      target.setAttribute('aria-describedby', [...ids].join(' '))
      tip.showPopover(); position()
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'aria-label', 'aria-pressed', 'data-tooltip', 'hidden', 'inert', 'class'] })
    }, delay)
  }
  const control = (node: EventTarget | null) => node instanceof Element ? node.closest<HTMLElement>('button, [role="button"], [data-tooltip]') : null
  document.addEventListener('pointerover', event => { if (event.pointerType === 'touch') return; const next = control(event.target); if (next) show(next, 300) })
  document.addEventListener('pointerout', event => {
    if (target && event.target instanceof Node && target.contains(event.target) && !(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) hide()
  })
  document.addEventListener('focusin', event => { const next = control(event.target); if (next) show(next, 150) })
  document.addEventListener('focusout', event => { if (target && event.target instanceof Node && target.contains(event.target)) hide() })
  document.addEventListener('pointerdown', hide, true)
  document.addEventListener('click', hide, true)
  document.addEventListener('keydown', hide, true)
  // Autofocus can scroll a newly opened dialog before the delay expires.
  document.addEventListener('scroll', () => { if (tip.matches(':popover-open')) hide() }, true)
  window.addEventListener('resize', hide)
  window.addEventListener('blur', hide)
}
