/** Shared local tools: native dialog focus containment, explicit busy/error states. */
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node
}
export function input(label: string, value = '', type = 'text') {
  const wrap = element('label', label, 'tool-field'), field = element('input')
  field.type = type; field.value = value; field.setAttribute('aria-label', label); wrap.append(field)
  return { wrap, field }
}
export function toolDialog(title: string, wide = false) {
  const previous = document.querySelector<HTMLDialogElement>('dialog.knowledge-dialog')
  if (previous) { previous.close(); previous.remove() }
  const prior = document.activeElement as HTMLElement | null
  const dialog = element('dialog', '', 'knowledge-dialog' + (wide ? ' wide' : ''))
  const heading = element('h2', title), body = element('div', '', 'tool-body')
  heading.id = 'tool-heading'; dialog.setAttribute('aria-labelledby', heading.id)
  const status = element('p', '', 'tool-status'); status.setAttribute('role', 'status')
  const footer = element('div', '', 'tool-actions'), close = element('button', '关闭')
  let busy = false
  close.onclick = () => { if (!busy) dialog.close() }
  dialog.addEventListener('cancel', e => { if (busy) e.preventDefault() })
  dialog.addEventListener('close', () => { dialog.remove(); if (!document.querySelector('dialog[open]')) { if (prior?.isConnected && prior !== document.body) prior.focus(); else document.getElementById('btn-tools')?.focus() } }, { once: true })
  footer.append(close); dialog.append(heading, body, status, footer); document.body.append(dialog); dialog.showModal()
  const run = async (operation: () => unknown | Promise<unknown>) => {
    if (busy) return
    busy = true; dialog.setAttribute('aria-busy', 'true'); status.textContent = '正在处理…'
    const controls = [...dialog.querySelectorAll<HTMLInputElement>('button, input, select, textarea')]
    const disabled = controls.map(c => c.disabled); controls.forEach(c => c.disabled = true)
    try { await operation(); if (status.textContent === '正在处理…') status.textContent = '' }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); status.classList.add('error') }
    finally { busy = false; dialog.removeAttribute('aria-busy'); controls.forEach((c, i) => c.disabled = disabled[i]) }
  }
  const button = (label: string, operation: () => unknown | Promise<unknown>, parent: HTMLElement = footer) => {
    const b = element('button', label); b.onclick = () => void run(operation); parent.append(b); return b
  }
  return { dialog, body, status, footer, button, run }
}
export type ToolDialog = ReturnType<typeof toolDialog>
