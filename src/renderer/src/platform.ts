/** Platform comes from the isolated preload, never from renderer user-agent guessing. */
export function formatShortcut(accelerator: string, platform = window.mdr.platform): string {
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  const modifiers = new Set(parts)
  const mac = platform === 'darwin'
  const command = modifiers.has('CmdOrCtrl') || modifiers.has('CommandOrControl')
  const control = modifiers.has('Ctrl') || modifiers.has('Control') || (command && !mac)
  const meta = modifiers.has('Cmd') || modifiers.has('Command') || modifiers.has('Meta') || (command && mac)
  const shift = modifiers.has('Shift')
  const alt = modifiers.has('Alt') || modifiers.has('Option')
  if (mac) return `${control ? '⌃' : ''}${alt ? '⌥' : ''}${shift ? '⇧' : ''}${meta ? '⌘' : ''}${key}`
  return [...(control ? ['Ctrl'] : []), ...(alt ? ['Alt'] : []), ...(shift ? ['Shift'] : []), ...(meta ? ['Super'] : []), key].join('+')
}

export function revealInFileManagerLabel(platform = window.mdr.platform): string {
  return platform === 'darwin' ? '在 Finder 中显示' : '在文件管理器中显示'
}

export function setupPlatformUi(platform = window.mdr.platform): void {
  document.body.dataset.platform = platform
  for (const element of document.querySelectorAll<HTMLElement>('[data-shortcut]')) {
    const shortcut = formatShortcut(element.dataset.shortcut ?? '', platform)
    if (element.tagName === 'KBD') {
      element.textContent = shortcut
    } else {
      const label = element.dataset.shortcutLabel ?? element.title.replace(/\s+\([^)]*\)$/, '')
      element.dataset.shortcutLabel = label
      element.title = `${label} (${shortcut})`
    }
  }
}
