import '../src/renderer/styles/app.css'
import '../src/renderer/styles/preview.css'
import officialCatalog from '../resources/plugin-catalog.json'
import { bootPlugins, registerBundledPlugin, pluginSnapshot } from '../src/renderer/src/pluginRuntime'
import { setupPluginCenter, openPluginCenter } from '../src/renderer/src/pluginCenter'

declare global { interface Window { pluginCenterTest: Promise<unknown>; __sandbox: (...args: any[]) => any } }
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message) }
const pause = () => new Promise(resolve => setTimeout(resolve, 10))
const wait = async (condition: () => boolean, message: string) => {
  for (let i = 0; i < 250; i++) { if (condition()) return; await pause() }
  throw new Error(message)
}
const card = (id: string) => document.querySelector<HTMLElement>(`.pc-card[data-id="${id}"]`)!
const state = (id: string) => pluginSnapshot().find(p => p.id === id)?.state
const status = () => document.getElementById('pc-status')!
const idle = () => wait(() => document.getElementById('pc-list')?.getAttribute('aria-busy') === 'false', 'Operation did not settle')
const click = async (selector: string, root: ParentNode = document) => {
  const button = root.querySelector<HTMLButtonElement>(selector)!
  assert(button && !button.disabled, 'Button unavailable: ' + selector)
  button.focus(); button.click(); await idle()
}
const descriptor = (id: string, commands = true) => ({ id, name: id, version: '1.0.0', mainUrl: `inkplug://${id}/main.mjs`, manifest: {
  id, name: id === 'demo' ? '示例命令' : '阅读辅助', version: '1.0.0', description: '按需启用，保持阅读界面简洁。',
  permissions: commands ? ['commands'] : ['render'], contributes: { commands: commands ? [{ id: `${id}.run`, title: '运行示例' }] : [] },
} })
const list = [descriptor('demo'), descriptor('reader', false)]
let available = officialCatalog.entries as any[]
let catalogWarning = ''
let catalogResult: any = { ok: true, id: 'inkleaf.reading-time' }
let localResult: any = { ok: false, canceled: true }
let starts = 0, disposed = 0, failure = true, installCount = 0, scanFailure = false, trashFailure = true, confirm = true
let gate: Promise<void> | undefined
let installResult: any = { ok: false, canceled: true }
window.__sandbox = (url, _permissions, register) => {
  const id = new URL(url).host
  starts++
  return {
    ready: Promise.resolve().then(async () => {
      if (id === 'demo') {
        await gate
        if (failure) throw Error('模拟入口加载失败')
        register({ type: 'command', token: 'cb-1', id: 'demo.run', title: '运行示例' })
      }
    }),
    invoke: async () => {}, dispose() { disposed++ },
  }
}
window.mdr = {
  pluginsCatalog: async () => ({ entries: available, source: 'bundled' }),
  pluginsCheckUpdates: async () => ({ entries: available, warning: catalogWarning, source: 'online', checkedAt: new Date().toISOString() }),
  pluginsInstallCatalog: async (id: string, version: string) => {
    if (!catalogResult.ok) return catalogResult
    const existing = list.find(p => p.id === id)
    const next = { ...descriptor(id, false), version, manifest: { ...descriptor(id, false).manifest, version } }
    if (existing) list.splice(list.indexOf(existing), 1, next); else list.push(next)
    return { ok: true, id }
  },
  pluginsUpdateLocal: async () => localResult,
  pluginsList: async () => { if (scanFailure) throw Error('模拟目录不可读'); return list },
  pluginsInstall: async () => { installCount++; return installResult },
  pluginsUninstall: async (id: string) => {
    if (trashFailure) return { ok: false, error: '模拟废纸篓不可用' }
    list.splice(list.findIndex(p => p.id === id), 1)
    return { ok: true }
  },
  pluginsReveal: async () => { throw Error('模拟文件管理器不可用') },
  confirm: async () => confirm,
} as any
registerBundledPlugin('bundled.callout', { name: '提示块', ...officialCatalog.entries[0], version: '0.1.1', permissions: ['render'] }, () => {})
setupPluginCenter()
const checks: string[] = []
async function check(name: string, body: () => unknown) { await body(); checks.push(name); console.log('PLUGIN_CENTER_CASE PASS', name) }
window.pluginCenterTest = (async () => {
  await bootPlugins()
  if (sessionStorage.getItem('restart')) {
    await check('fresh page restores enabled render-only and disabled bundled plugins', () => {
      assert(state('reader') === 'active', 'Enabled render plugin was not restored')
      assert(state('bundled.callout') === 'disabled', 'Disabled bundled plugin was reactivated')
      assert(state('demo') === 'registered', 'Uninstalled command plugin retained enabled preference')
    })
    openPluginCenter(); await idle()
    await click('[data-action="details"]', card('bundled.callout'))
    await click('#pc-tab-examples')
    return { passed: true, checks }
  }
  await check('dialog keyboard focus is contained and restored', async () => {
    const trigger = document.getElementById('btn-plugins')!
    trigger.focus(); trigger.click(); await idle()
    const close = document.querySelector<HTMLButtonElement>('.pc-close')!
    assert(document.activeElement === close, 'Initial dialog focus missing')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    assert(document.activeElement?.id === 'pc-refresh', 'Shift+Tab escaped the dialog')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    assert(document.activeElement === close, 'Tab escaped the dialog')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert(document.activeElement === trigger && !document.getElementById('pc-overlay')!.classList.contains('visible'), 'Escape failed to restore focus')
    trigger.click(); await idle()
  })
  await check('registered enable, pending lock, failure and retry work through real buttons', async () => {
    let release!: () => void
    gate = new Promise(resolve => { release = resolve })
    const button = card('demo').querySelector<HTMLButtonElement>('[data-action="toggle"]')!
    button.focus(); button.click(); button.click()
    await wait(() => state('demo') === 'activating', 'Registered plugin did not activate')
    assert(document.getElementById('pc-list')!.getAttribute('aria-busy') === 'true', 'Missing pending state')
    assert(card('demo').querySelector<HTMLButtonElement>('[data-action="toggle"]')!.disabled, 'Double activation was allowed')
    assert((document.getElementById('pc-install') as HTMLButtonElement).disabled, 'Concurrent install was allowed')
    release(); await idle()
    assert(starts === 1 && state('demo') === 'error', 'Failed activation did not finish once')
    assert(card('demo').querySelector('.pc-error')?.textContent?.includes('模拟入口'), 'Plugin error was hidden')
    assert(card('demo').querySelector<HTMLButtonElement>('.pc-cmd')!.disabled, 'Failed plugin command remains available')
    assert(card('demo').querySelector('[data-action="toggle"]')?.textContent === '重试启用', 'Retry affordance missing')
    failure = false
    await click('[data-action="toggle"]', card('demo'))
    assert(state('demo') === 'active' && starts === 2, 'Retry did not start one fresh instance')
    assert(!card('demo').querySelector('.pc-error'), 'Retry retained stale error')
    assert((document.activeElement as HTMLElement).dataset.action === 'toggle', 'Rerender lost action focus')
  })
  await check('reload preserves disabled state and replaces an active instance', async () => {
    await click('[data-action="toggle"]', card('demo'))
    assert(card('demo').querySelector<HTMLButtonElement>('.pc-cmd')!.disabled, 'Disabled command remains available')
    await click('[data-action="reload"]', card('demo'))
    assert(state('demo') === 'disabled' && starts === 2, 'Reload re-enabled a disabled plugin')
    await click('[data-action="toggle"]', card('demo'))
    const before = disposed
    await click('[data-action="reload"]', card('demo'))
    assert(state('demo') === 'active' && disposed === before + 1, 'Reload did not replace active sandbox')
  })
  await check('cancelled or failed uninstall leaves the active plugin usable', async () => {
    confirm = false
    await click('[data-action="uninstall"]', card('demo'))
    assert(state('demo') === 'active' && status().textContent?.includes('已取消'), 'Cancel changed plugin state')
    confirm = true
    await click('[data-action="uninstall"]', card('demo'))
    assert(state('demo') === 'active' && status().classList.contains('error'), 'Failed uninstall silently disabled the plugin')
    assert(!card('demo').querySelector<HTMLButtonElement>('.pc-cmd')!.disabled, 'Failed uninstall removed the command')
    trashFailure = false
    await click('[data-action="uninstall"]', card('demo'))
    assert(!card('demo') && !state('demo'), 'Successful uninstall left a stale card')
  })
  await check('install cancellation, errors and success are distinguished', async () => {
    await click('#pc-install')
    assert(status().textContent?.includes('已取消') && !status().classList.contains('error'), 'Cancel was shown as failure')
    installResult = { ok: false, error: '模拟无效插件' }
    await click('#pc-install')
    assert(status().textContent?.includes('模拟无效插件') && status().classList.contains('error'), 'Install error was hidden')
    installResult = { ok: true, id: 'demo' }; list.push(descriptor('demo'))
    await click('#pc-install')
    assert(state('demo') === 'registered' && installCount === 3, 'Installed plugin not discovered')
    assert(status().textContent?.includes('已安装') && status().textContent?.includes('启用'), 'No next step after install')
  })
  await check('scan and file manager errors appear inline without losing installed plugins', async () => {
    scanFailure = true
    await click('#pc-refresh')
    assert(card('reader') && status().textContent?.includes('模拟目录不可读'), 'Scan failure emptied or silently retained the list')
    scanFailure = false
    await click('#pc-reveal')
    assert(status().textContent?.includes('模拟文件管理器不可用'), 'Reveal error was hidden')
    await click('#pc-refresh')
    assert(!status().classList.contains('error'), 'Success retained an error style')
  })
  await check('discovery search, category filter and empty state operate on real metadata', async () => {
    await click('[data-view="discover"]')
    assert(document.querySelectorAll('.pc-card').length === 3, 'Official directory missing')
    const input = document.getElementById('pc-search') as HTMLInputElement
    input.value = '阅读时间'; input.dispatchEvent(new Event('input'))
    assert(document.querySelectorAll('.pc-card').length === 1 && card('inkleaf.reading-time'), 'Search did not filter')
    input.value = 'missing-plugin'; input.dispatchEvent(new Event('input'))
    assert(document.querySelector('.pc-empty')?.textContent?.includes('没有匹配'), 'Search empty state missing')
    input.value = ''; input.dispatchEvent(new Event('input'))
    const category = document.getElementById('pc-category') as HTMLSelectElement
    category.value = '排版'; category.dispatchEvent(new Event('change'))
    assert(document.querySelectorAll('.pc-card').length === 1 && card('bundled.callout'), 'Category filter did not apply')
    category.value = ''; category.dispatchEvent(new Event('change'))
  })
  await check('callout detail renders every type with distinct computed colors in light and dark themes', async () => {
    await click('[data-action="details"]', card('bundled.callout'))
    await click('#pc-tab-examples')
    assert(document.querySelectorAll('.pc-example').length === 24, 'All callout types must have examples')
    for (const theme of ['light', 'dark']) {
      document.body.dataset.theme = theme
      const color = (type: string) => getComputedStyle(document.querySelector('.pc-example-preview .md-callout-' + type)!).borderLeftColor
      assert(color('note') !== color('tip') && color('tip') !== color('warning') && color('warning') !== color('danger'), 'Callout colors still overridden')
      assert(color('warning') === getComputedStyle(document.querySelector('.pc-example-preview .md-callout-warning')!, '::before').color, 'Title and border colors diverged')
    }
    const oldClipboard = navigator.clipboard
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text } } })
    try {
      await click('[data-copy="0"]')
      await wait(() => status().textContent?.includes('已复制') === true, 'Copy result not announced')
      assert(copied.includes('> [!note]'), 'Copy button did not copy the Markdown syntax')
    } finally { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: oldClipboard }) }
    await click('#pc-tab-versions')
    assert(document.getElementById('pc-detail-content')!.textContent!.includes('0.1.1'), 'Version history missing')
    document.getElementById('pc-tab-versions')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    assert(document.getElementById('pc-tab-examples')!.getAttribute('aria-selected') === 'true', 'Keyboard tabs unavailable')
  })
  await check('discovery installs without enabling and displays cancelled or failed installations', async () => {
    catalogResult = { ok: false, canceled: true }
    await click('[data-action="catalog"]', card('inkleaf.reading-time'))
    assert(status().textContent?.includes('已取消') && !state('inkleaf.reading-time'), 'Cancelled catalog install changed state')
    catalogResult = { ok: false, error: '模拟校验失败' }
    await click('[data-action="catalog"]', card('inkleaf.reading-time'))
    assert(status().textContent?.includes('模拟校验失败'), 'Catalog error hidden')
    catalogResult = { ok: true }
    await click('[data-action="catalog"]', card('inkleaf.reading-time'))
    assert(state('inkleaf.reading-time') === 'registered', 'Catalog install enabled without explicit choice')
  })
  await check('update filtering, disabled and active lifecycle preservation, and offline fallback', async () => {
    const reader = { id: 'reader', name: '阅读辅助', version: '1.1.0', permissions: ['render'], description: '新版阅读辅助' }
    available = [...available.map(p => p.id === 'bundled.callout' ? { ...p, version: '0.1.2' } : p), reader]
    await click('#pc-check-updates')
    await click('[data-view="updates"]')
    assert(card('reader') && document.querySelectorAll('.pc-card').length === 2, 'Update tab must include outdated bundled plugin and external plugin')
    await click('[data-action="toggle"]', card('reader'))
    assert(state('reader') === 'active', 'Reader not enabled')
    await click('[data-action="toggle"]', card('reader'))
    await click('[data-action="details"]', card('reader'))
    await click('#pc-upgrade')
    assert(state('reader') === 'disabled' && pluginSnapshot().find(p => p.id === 'reader')!.version === '1.1.0', 'Update did not preserve disabled preference')
    available = available.map(p => p.id === 'reader' ? { ...p, version: '1.2.0' } : p)
    await click('#pc-check-updates')
    await click('[data-action="toggle"]', card('reader'))
    await click('[data-action="details"]', card('reader'))
    const before = starts
    await click('#pc-upgrade')
    assert(state('reader') === 'active' && starts === before + 1, 'Update failed to replace exactly one running instance')
    catalogWarning = '离线，继续使用上次保存的目录'
    await click('#pc-check-updates')
    assert(status().classList.contains('error') && status().textContent?.includes('离线'), 'Offline warning hidden')
    assert(document.getElementById('pc-count-discover')!.textContent === '4', 'Offline failure lost cached directory')
    catalogWarning = ''
    await click('[data-view="installed"]')
    await click('[data-action="details"]', card('reader'))
    await click('#pc-local-update')
    assert(status().textContent?.includes('已取消') && state('reader') === 'active', 'Cancelled local update disturbed running plugin')
    localResult = { ok: false, error: '版本必须更高' }
    await click('#pc-local-update')
    assert(status().textContent?.includes('版本必须更高') && state('reader') === 'active', 'Local update failure lost the plugin')
    // Leave the original final preference check expecting a single enable click.
    await click('[data-action="toggle"]', card('reader'))
  })
  await click('[data-action="toggle"]', card('reader'))
  await click('[data-action="toggle"]', card('bundled.callout'))
  sessionStorage.setItem('restart', 'true')
  return { passed: true, checks }
})().catch(error => ({ passed: false, checks, error: String(error), stack: error.stack }))
