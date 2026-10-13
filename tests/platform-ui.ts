import '../src/renderer/styles/app.css'
import '../src/renderer/styles/preview.css'
import { formatShortcut, revealInFileManagerLabel, setupPlatformUi } from '../src/renderer/src/platform'
import { setupUpdater } from '../src/renderer/src/updater'
import type { UpdateState } from '../src/shared/updates'
import type { MdrApi } from '../src/preload/index'

declare global {
  interface Window {
    mdr: MdrApi
    platformUiTest: Promise<{ passed: boolean; checks: string[]; error?: string }>
  }
}

const checks: string[] = []
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 15))
const query = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const action = (label: string): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('.ink-update-panel button')].find(el => el.textContent === label)!
let state: UpdateState = { status: 'unsupported', currentVersion: '0.2.3', installationKind: 'deb', message: '开发模式不安装更新，请使用安装后的墨页。' }
const listeners = new Set<(state: UpdateState) => void>()
const counts = { check: 0, download: 0, cancel: 0, install: 0, save: 0 }
const emit = (next: UpdateState) => { state = next; for (const listener of listeners) listener(next) }
let failSave = false
let failInstall = false
const urls: string[] = []
window.open = (url) => { urls.push(String(url)); return null }
const fixtureApi = {
  platform: 'linux',
  sandboxed: true,
  getUpdateState: async () => state,
  checkForUpdates: async () => { counts.check++; return state },
  downloadUpdate: async () => { counts.download++; emit({ ...state, status: 'downloading', progress: 0 }); return state },
  cancelUpdate: async () => { counts.cancel++; emit({ ...state, status: 'available', progress: undefined }); return state },
  installUpdate: async () => {
    counts.install++
    emit({ ...state, status: failInstall ? 'ready' : 'installing', message: failInstall ? '安装未开始：应用目录只读。可以重试。' : undefined })
    return state
  },
  onUpdateState: (listener: (next: UpdateState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  onMenu: () => () => {},
}
// This mock is confined to the separate test renderer, never exposed by the app.
Object.assign(window, { mdr: fixtureApi as unknown as MdrApi })
const releaseUrl = 'https://github.com/Fovercon/Inkleaf/releases/tag/v0.2.4'
const candidate: UpdateState = { status: 'available', currentVersion: '0.2.3', version: '0.2.4', installationKind: 'deb', releaseUrl, releaseNotes: '<img src=x onerror=alert(1)>\n本次更新' }
const beforeInstall = async () => { counts.save++; if (failSave) throw new Error('磁盘空间不足'); await tick() }

window.platformUiTest = (async () => {
  assert(formatShortcut('CmdOrCtrl+Shift+O', 'darwin') === '⇧⌘O', 'Mac modifier order must remain unchanged')
  assert(formatShortcut('CmdOrCtrl+Shift+O', 'linux') === 'Ctrl+Shift+O', 'Linux uses Ctrl and Shift labels')
  assert(formatShortcut('CmdOrCtrl+\\', 'linux') === 'Ctrl+\\', 'Backslash key must remain literal')
  assert(revealInFileManagerLabel('darwin') === '在 Finder 中显示', 'Mac keeps Finder wording')
  assert(revealInFileManagerLabel('linux') === '在文件管理器中显示', 'Linux uses its system file manager')
  setupPlatformUi('darwin')
  assert(query('#btn-open-folder').title === '打开文件夹 (⇧⌘O)', 'Mac toolbar hint unchanged')
  assert(query('#empty-open-folder kbd').textContent === '⇧⌘O', 'Mac welcome hint unchanged')
  assert(getComputedStyle(query('#titlebar')).paddingLeft === '90px', 'Mac traffic-light space remains')
  setupPlatformUi('linux')
  assert(query('#btn-open-folder').title === '打开文件夹 (Ctrl+Shift+O)', 'Linux toolbar hint updated')
  assert(query('#empty-open-folder kbd').textContent === 'Ctrl+Shift+O', 'Linux welcome hint updated')
  assert(query('.status-shortcut kbd').textContent === 'Ctrl+P', 'Linux status hint updated')
  assert([...document.querySelectorAll<HTMLElement>('[data-shortcut]')].every(el => !/⌘|⇧/.test(el.tagName === 'KBD' ? el.textContent ?? '' : el.title)), 'Every Linux shortcut hint must use Linux modifiers')
  assert(getComputedStyle(query('#titlebar')).paddingLeft === '18px', 'Linux must not reserve traffic-light space')
  assert(getComputedStyle(query('#titlebar')).getPropertyValue('-webkit-app-region') === 'no-drag', 'Linux native title bar owns dragging')
  assert(getComputedStyle(document.body).fontFamily.includes('Noto Sans'), 'Linux gets cross-platform font fallbacks')
  setupPlatformUi('linux')
  assert(query('#btn-open-folder').title === '打开文件夹 (Ctrl+Shift+O)', 'Setup is idempotent')
  checks.push('Mac/Linux toolbar, welcome, status, file-manager labels, fonts and title-bar layout')

  let dispose = setupUpdater(beforeInstall)
  await tick()
  query<HTMLButtonElement>('#btn-updates').click()
  await tick()
  assert(query('#ink-update-description').textContent?.includes('开发模式'), 'Unsupported reason is shown')
  assert(action('下载更新').hidden && action('保存并重启安装').hidden, 'Unsupported builds never offer installation')
  emit(candidate)
  assert(query('#ink-update-description').textContent?.includes('系统包管理器'), 'deb clearly explains manual package installation')
  assert(!query('#ink-update-description').textContent?.includes('重启'), 'deb never promises a restart update')
  assert(action('下载更新').hidden && action('保存并重启安装').hidden, 'deb hides automatic actions')
  action('下载更新').click(); action('保存并重启安装').click()
  await tick()
  assert(counts.download === 0 && counts.install === 0 && counts.save === 0, 'Hidden deb actions cannot trigger backend calls')
  action('查看安装包').click()
  assert(urls.length === 1 && urls[0] === releaseUrl, 'deb opens the official version page')
  assert(!query('.ink-update-notes img'), 'Release notes remain plain text')
  emit({ ...candidate, status: 'error', message: '网络暂时不可用' })
  assert(action('重新下载').hidden && action('保存并重启安装').hidden && !action('重试检查').hidden, 'deb error retries the check rather than an automatic download')
  emit({ ...candidate, status: 'ready' })
  assert(action('保存并重启安装').hidden && !query('#ink-update-description').textContent?.includes('重启'), 'Unexpected deb ready status still stays manual')
  dispose()
  checks.push('Unsupported and deb manual-update flow, safe links, action guards and plain-text release notes')

  state = { ...candidate, installationKind: 'appimage' }
  const editor = query<HTMLInputElement>('#tree-filter-input')
  editor.focus()
  dispose = setupUpdater(beforeInstall)
  await tick()
  assert(!query('.ink-update-notice').hidden && document.activeElement === editor, 'AppImage notice preserves editing focus')
  query<HTMLButtonElement>('.ink-update-notice-open').click()
  action('下载更新').click(); action('下载更新').click()
  await tick()
  assert(counts.download === 1, 'AppImage duplicate download is guarded')
  emit({ ...state, progress: 42 })
  assert(query<HTMLProgressElement>('progress').value === 42, 'AppImage progress is rendered')
  action('后台下载').click()
  assert(query('.ink-update-overlay').hidden && counts.cancel === 0, 'Closing keeps AppImage download running')
  assert(document.activeElement === editor, 'Close returns editing focus')
  query<HTMLButtonElement>('#btn-updates').click()
  const cancelButton = action('取消下载')
  cancelButton.click(); cancelButton.click()
  await tick()
  assert(counts.cancel === 1, 'AppImage cancellation is guarded')
  emit({ ...state, status: 'ready' })
  failSave = true
  const installButton = action('保存并重启安装')
  installButton.click(); installButton.click()
  await tick()
  assert(counts.save === 1 && counts.install === 0, 'Save failure blocks AppImage installation')
  assert(query('.ink-update-error').textContent?.includes('磁盘空间不足'), 'Save error is visible')
  failSave = false; failInstall = true
  action('保存并重启安装').click()
  await tick(); await tick()
  assert(counts.install === 1 && query('.ink-update-error').textContent?.includes('应用目录只读'), 'Backend installation preflight error remains recoverable')
  failInstall = false
  action('保存并重启安装').click()
  assert(query<HTMLButtonElement>('.ink-update-close').disabled, 'Close is blocked while saving before installation')
  await tick(); await tick()
  assert(counts.install === 2 && query('.ink-update-panel').dataset.status === 'installing', 'Successful save starts AppImage installation')
  assert(action('正在安装…').disabled, 'Repeated AppImage installation is prevented')
  dispose()
  checks.push('AppImage download, progress, cancellation, save safeguards, installation retry and focus preservation')

  setupPlatformUi('darwin')
  state = { ...candidate, status: 'ready', installationKind: 'mac-app' }
  dispose = setupUpdater(beforeInstall)
  await tick()
  query<HTMLButtonElement>('.ink-update-notice-open').click()
  assert(!action('保存并重启安装').hidden, 'Mac retains its existing automatic installation action')
  dispose()
  setupPlatformUi('linux')
  checks.push('Mac update controls remain unchanged')
  return { passed: true, checks }
})().catch(error => ({ passed: false, checks, error: error instanceof Error ? error.stack : String(error) }))
