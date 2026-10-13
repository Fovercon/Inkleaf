import type { UpdateState } from '../../shared/updates'
import '../styles/updates.css'

type UpdateAction = 'check' | 'download' | 'install'

function button(label: string, className: string): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = className
  el.textContent = label
  return el
}

function limited(value: string | undefined, length = 400): string {
  return (value ?? '').slice(0, length)
}

function safeReleaseUrl(value: string | undefined): string | null {
  if (!value || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

/** The main process owns update state; this view never starts an automatic install. */
export function setupUpdater(beforeInstall: () => Promise<void>): () => void {
  const trigger = document.getElementById('btn-updates')
  const overlay = document.createElement('div')
  overlay.className = 'ink-update-overlay'
  overlay.hidden = true

  const panel = document.createElement('section')
  panel.className = 'ink-update-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-labelledby', 'ink-update-label')
  panel.setAttribute('aria-describedby', 'ink-update-description')
  panel.tabIndex = -1
  panel.innerHTML = `<header class="ink-update-header">
    <div class="ink-update-brand"><svg aria-hidden="true"><use href="#i-brand"/></svg><div><span id="ink-update-label">墨页更新</span><small>INKLEAF</small></div></div>
  </header>
  <div class="ink-update-content">
    <div class="ink-update-version"></div>
    <div class="ink-update-summary" role="status" aria-live="polite" aria-atomic="true">
      <h2 class="ink-update-heading"></h2><p id="ink-update-description"></p>
    </div>
    <div class="ink-update-progress" hidden><progress max="100" aria-label="新版本下载进度"></progress><span></span></div>
    <p class="ink-update-error" role="alert" hidden></p>
    <details class="ink-update-notes" hidden><summary>本次更新</summary><div></div></details>
  </div>
  <footer class="ink-update-footer"><div class="ink-update-actions"></div><p>发现新版本时会提醒你，下载和安装由你决定。</p></footer>`
  overlay.appendChild(panel)

  const closeButton = button('×', 'ink-update-close')
  closeButton.setAttribute('aria-label', '关闭更新窗口')
  panel.querySelector('.ink-update-header')!.appendChild(closeButton)
  const actions = panel.querySelector<HTMLElement>('.ink-update-actions')!
  const dismissButton = button('关闭', 'ink-update-button ink-update-secondary')
  const releaseButton = button('查看版本详情', 'ink-update-button ink-update-link')
  const cancelButton = button('取消下载', 'ink-update-button ink-update-secondary')
  const checkButton = button('检查更新', 'ink-update-button ink-update-primary')
  const downloadButton = button('下载更新', 'ink-update-button ink-update-primary')
  const installButton = button('保存并重启安装', 'ink-update-button ink-update-primary')
  actions.append(releaseButton, dismissButton, cancelButton, checkButton, downloadButton, installButton)

  const versionEl = panel.querySelector<HTMLElement>('.ink-update-version')!
  const headingEl = panel.querySelector<HTMLElement>('.ink-update-heading')!
  const descriptionEl = panel.querySelector<HTMLElement>('#ink-update-description')!
  const errorEl = panel.querySelector<HTMLElement>('.ink-update-error')!
  const notesEl = panel.querySelector<HTMLDetailsElement>('.ink-update-notes')!
  const notesContent = notesEl.querySelector<HTMLElement>('div')!
  const progressEl = panel.querySelector<HTMLElement>('.ink-update-progress')!
  const progressBar = progressEl.querySelector<HTMLProgressElement>('progress')!
  const progressLabel = progressEl.querySelector<HTMLElement>('span')!
  const footerNote = panel.querySelector<HTMLElement>('.ink-update-footer p')!

  const notice = document.createElement('aside')
  notice.className = 'ink-update-notice'
  notice.hidden = true
  const noticeText = document.createElement('span')
  noticeText.className = 'ink-update-notice-text'
  noticeText.setAttribute('role', 'status')
  noticeText.setAttribute('aria-live', 'polite')
  const noticeOpen = button('查看更新', 'ink-update-notice-open')
  const noticeDismiss = button('×', 'ink-update-notice-dismiss')
  noticeDismiss.setAttribute('aria-label', '稍后查看更新')
  notice.append(noticeText, noticeOpen, noticeDismiss)
  document.body.append(overlay, notice)

  let state: UpdateState = { status: 'idle', currentVersion: '' }
  let pending: UpdateAction | null = null
  let cancelPending = false
  let saving = false
  let localError = ''
  let returnFocus: HTMLElement | null = null
  let revision = 0
  let disposed = false
  const dismissedNotices = new Set<string>()

  const manualInstall = () => state.installationKind === 'deb'
  const noticeKey = () => `${state.version ?? ''}:${state.status}`
  const locked = () => !manualInstall() && (saving || pending === 'install' || state.status === 'installing')
  const focusable = () => [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), summary, [tabindex="0"]')]
    .filter((el) => !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0)

  const close = () => {
    if (locked() || overlay.hidden) return
    overlay.hidden = true
    dismissedNotices.add(noticeKey())
    notice.hidden = true
    if (returnFocus?.isConnected && !returnFocus.closest('[hidden]')) returnFocus.focus({ preventScroll: true })
    else trigger?.focus({ preventScroll: true })
    returnFocus = null
  }

  const render = () => {
    if (disposed) return
    const { status } = state
    const manual = manualInstall()
    const version = limited(state.version, 50)
    const current = limited(state.currentVersion, 50)
    versionEl.textContent = current ? `当前版本 ${current}` : '墨页 · Inkleaf'
    let heading = '保持墨页常新'
    let description = manual ? '墨页会检查新版本。新版 deb 需要使用系统包管理器安装。' : '新版本准备好时，墨页会提醒你。'
    if (status === 'checking' || pending === 'check') {
      heading = '正在检查更新'
      description = '稍等片刻，正在查找新版本。'
    } else if (status === 'available') {
      heading = '新的一页，已经准备好'
      description = manual
        ? `发现 Inkleaf ${version}。请在版本发布页下载新版 deb，并使用系统包管理器安装。`
        : `发现 Inkleaf ${version}。现在下载，或继续写作，稍后再更新。`
    } else if (status === 'downloading' || pending === 'download') {
      heading = '正在下载新版本'
      description = '关闭此窗口后，下载仍会继续。'
    } else if (status === 'ready') {
      heading = '新版本已准备就绪'
      description = `Inkleaf ${version} 已下载。安装前会保存当前文档，随后重启墨页。`
    } else if (status === 'installing' || pending === 'install') {
      heading = saving ? '正在保存文档' : '正在安装新版本'
      description = saving ? '保存完成后，将安装新版本并重启墨页。' : '墨页即将重启，请稍等片刻。'
    } else if (status === 'up-to-date') {
      heading = '已经是最新版本'
      description = current ? `你正在使用 Inkleaf ${current}。` : '你正在使用最新版本的墨页。'
    } else if (status === 'error') {
      heading = manual ? '暂时无法检查新版本' : '暂时无法完成更新'
      description = limited(state.message) || '请检查网络连接后重试。'
    } else if (status === 'unsupported') {
      heading = '当前版本暂不支持自动更新'
      description = limited(state.message) || '请从版本发布页下载并安装新版墨页。'
    }
    if (manual && ['downloading', 'ready', 'installing'].includes(status)) {
      heading = '请使用系统包管理器更新'
      description = `Inkleaf ${version} 的 deb 需要手动安装。请从版本发布页下载安装包，再使用系统包管理器更新。`
    }
    // Saving precedes the authoritative installing event while ready stays intact.
    if (saving) {
      heading = '正在保存文档'
      description = '保存完成后，将安装新版本并重启墨页。'
    }
    if (headingEl.textContent !== heading) headingEl.textContent = heading
    if (descriptionEl.textContent !== description) descriptionEl.textContent = description
    panel.dataset.status = saving ? 'saving' : status
    panel.dataset.installationKind = state.installationKind ?? ''
    panel.setAttribute('aria-busy', String(!manual && (saving || status === 'installing')))

    progressEl.hidden = manual || status !== 'downloading'
    const progress = state.progress
    if (typeof progress === 'number' && Number.isFinite(progress)) {
      const percent = Math.min(100, Math.max(0, progress))
      progressBar.value = percent
      progressLabel.textContent = `${Math.floor(percent)}%`
    } else {
      progressBar.removeAttribute('value')
      progressLabel.textContent = '准备下载…'
    }
    const installError = !manual && status === 'ready' && state.message?.startsWith('安装未开始') ? limited(state.message) : ''
    const visibleError = localError || installError
    errorEl.hidden = !visibleError
    errorEl.textContent = visibleError
    const notes = limited(state.releaseNotes, 6000).trim()
    notesEl.hidden = !notes || !['available', 'downloading', 'ready', 'error'].includes(status)
    // Release notes are remote content and must remain plain text.
    if (notesContent.textContent !== notes) notesContent.textContent = notes
    releaseButton.hidden = !safeReleaseUrl(state.releaseUrl)
    releaseButton.textContent = manual ? '查看安装包' : '查看版本详情'
    releaseButton.className = manual ? 'ink-update-button ink-update-primary ink-update-manual' : 'ink-update-button ink-update-link'
    checkButton.hidden = !['idle', 'up-to-date', 'error'].includes(status)
    checkButton.textContent = status === 'error' ? '重试检查' : '检查更新'
    downloadButton.hidden = manual || (status !== 'available' && !(status === 'error' && !!state.version))
    downloadButton.textContent = status === 'error' ? '重新下载' : '下载更新'
    installButton.hidden = manual || (status !== 'ready' && status !== 'installing')
    installButton.textContent = saving ? '正在保存…' : status === 'installing' ? '正在安装…' : '保存并重启安装'
    cancelButton.hidden = manual || status !== 'downloading'
    cancelButton.textContent = cancelPending ? '正在取消…' : '取消下载'
    dismissButton.textContent = ['available', 'ready'].includes(status) ? '稍后' : !manual && status === 'downloading' ? '后台下载' : '关闭'
    closeButton.disabled = locked()
    dismissButton.disabled = locked()
    releaseButton.disabled = locked()
    checkButton.disabled = pending !== null || status === 'checking'
    downloadButton.disabled = pending !== null
    installButton.disabled = pending !== null || locked()
    cancelButton.disabled = cancelPending || locked()

    const actionable = status === 'available' || status === 'ready'
    if (trigger) {
      trigger.dataset.updateAvailable = String(actionable)
      const label = actionable ? manual ? '有新版安装包，查看更新' : '新版本已准备好，查看更新' : '检查更新'
      trigger.setAttribute('aria-label', label)
      trigger.title = label
    }
    notice.hidden = !overlay.hidden || !actionable || dismissedNotices.has(noticeKey())
    noticeText.textContent = manual ? `Inkleaf ${version} 新版安装包已发布` : status === 'ready' ? `Inkleaf ${version} 已准备就绪` : `Inkleaf ${version} 可以更新了`
    footerNote.textContent = manual ? '新版 deb 需通过系统包管理器安装。' : '发现新版本时会提醒你，下载和安装由你决定。'
  }

  const receive = (next: UpdateState) => {
    if (disposed) return
    revision++
    state = next
    render()
  }

  const run = async (action: UpdateAction) => {
    if (pending || locked()) return
    if (manualInstall() && action !== 'check') return
    if (action === 'check' && ['checking', 'downloading', 'ready', 'installing'].includes(state.status)) return
    if (action === 'download' && state.status !== 'available' && !(state.status === 'error' && state.version)) return
    if (action === 'install' && state.status !== 'ready') return
    pending = action
    localError = ''
    saving = action === 'install'
    render()
    try {
      if (action === 'install') {
        try {
          await beforeInstall()
        } catch (error) {
          localError = `文档未能保存，暂未安装更新。${error instanceof Error ? limited(error.message, 240) : '请先保存文档后重试。'}`
          return
        }
        saving = false
        render()
      }
      const startedAt = revision
      const next = await (action === 'check' ? window.mdr.checkForUpdates()
        : action === 'download' ? window.mdr.downloadUpdate() : window.mdr.installUpdate())
      // The event stream may already have advanced past this method's result.
      if (!disposed && revision === startedAt) receive(next)
    } catch (error) {
      localError = limited(error instanceof Error ? error.message : '暂时无法完成操作，请稍后重试。')
    } finally {
      pending = null
      saving = false
      render()
    }
  }

  const open = (check: boolean) => {
    if (disposed) return
    const wasClosed = overlay.hidden
    if (wasClosed) {
      const active = document.activeElement
      // A notice is hidden while the panel is open; return to the persistent toolbar.
      returnFocus = active instanceof HTMLElement && !notice.contains(active) ? active : trigger
    }
    overlay.hidden = false
    notice.hidden = true
    render()
    if (wasClosed) panel.focus({ preventScroll: true })
    if (check) void run('check')
  }

  const onTrigger = () => open(true)
  const onFocus = (event: FocusEvent) => {
    if (!overlay.hidden && event.target instanceof Node && !panel.contains(event.target)) {
      ;(focusable()[0] ?? panel).focus({ preventScroll: true })
    }
  }
  const onKey = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'Tab') {
      const items = focusable()
      const currentIndex = items.indexOf(document.activeElement as HTMLElement)
      if (!items.length) {
        event.preventDefault()
        panel.focus()
      } else if (currentIndex < 0 || (event.shiftKey && currentIndex === 0) || (!event.shiftKey && currentIndex === items.length - 1)) {
        event.preventDefault()
        items[event.shiftKey ? items.length - 1 : 0].focus()
      }
    }
  }
  closeButton.addEventListener('click', close)
  dismissButton.addEventListener('click', close)
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close() })
  overlay.addEventListener('keydown', onKey)
  document.addEventListener('focusin', onFocus)
  trigger?.addEventListener('click', onTrigger)
  checkButton.addEventListener('click', () => { void run('check') })
  downloadButton.addEventListener('click', () => { void run('download') })
  installButton.addEventListener('click', () => { void run('install') })
  cancelButton.addEventListener('click', () => {
    if (manualInstall() || cancelPending || locked() || state.status !== 'downloading') return
    cancelPending = true
    localError = ''
    render()
    const startedAt = revision
    void window.mdr.cancelUpdate().then((next) => {
      if (!disposed && revision === startedAt) receive(next)
    }).catch((error) => {
      localError = limited(error instanceof Error ? error.message : '取消下载失败，请稍后重试。')
    }).finally(() => {
      cancelPending = false
      render()
    })
  })
  releaseButton.addEventListener('click', () => {
    const url = safeReleaseUrl(state.releaseUrl)
    if (url && !locked()) window.open(url, '_blank', 'noopener,noreferrer')
  })
  noticeOpen.addEventListener('click', () => open(false))
  noticeDismiss.addEventListener('click', () => {
    dismissedNotices.add(noticeKey())
    notice.hidden = true
  })
  const unsubscribeState = window.mdr.onUpdateState(receive)
  const unsubscribeMenu = window.mdr.onMenu((action) => { if (action === 'check-updates') open(true) })
  const initialRevision = revision
  void window.mdr.getUpdateState().then((initial) => {
    if (!disposed && revision === initialRevision) receive(initial)
  }).catch((error) => {
    if (!disposed && revision === initialRevision) {
      receive({ ...state, status: 'error', message: limited(error instanceof Error ? error.message : '暂时无法检查更新，请稍后重试。') })
    }
  })
  render()

  return () => {
    disposed = true
    unsubscribeState()
    unsubscribeMenu()
    trigger?.removeEventListener('click', onTrigger)
    document.removeEventListener('focusin', onFocus)
    if (!overlay.hidden && returnFocus?.isConnected && !returnFocus.closest('[hidden]')) returnFocus.focus({ preventScroll: true })
    overlay.remove()
    notice.remove()
  }
}
