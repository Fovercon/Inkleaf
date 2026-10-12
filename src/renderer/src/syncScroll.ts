import { EditorPane } from './editor'

/**
 * Bidirectional scroll sync between the CodeMirror editor and the rendered preview,
 * mapped through the `data-source-line` attributes injected during markdown rendering.
 */
export function setupSync(editor: EditorPane, previewScroller: HTMLElement, isEnabled: () => boolean) {
  let syncing = false
  const unlock = () => {
    setTimeout(() => {
      syncing = false
    }, 80)
  }

  editor.onScroll(() => {
    if (syncing || !isEnabled()) return
    syncing = true
    const line = editor.lineAtTop()
    let target: HTMLElement | null = null
    previewScroller.querySelectorAll<HTMLElement>('[data-source-line]').forEach((el) => {
      const l = Number(el.dataset.sourceLine)
      if (l <= line) target = el
    })
    if (target) {
      const t = target as HTMLElement
      const top =
        t.getBoundingClientRect().top -
        previewScroller.getBoundingClientRect().top +
        previewScroller.scrollTop -
        8
      previewScroller.scrollTo({ top: Math.max(0, top) })
    }
    unlock()
  })

  previewScroller.addEventListener(
    'scroll',
    () => {
      if (syncing || !isEnabled()) return
      syncing = true
      const threshold = previewScroller.getBoundingClientRect().top + 24
      let line = 1
      previewScroller.querySelectorAll<HTMLElement>('[data-source-line]').forEach((el) => {
        if (el.getBoundingClientRect().top <= threshold) {
          line = Math.max(line, Number(el.dataset.sourceLine))
        }
      })
      if (line > 1) editor.scrollToLine(line)
      unlock()
    },
    { passive: true },
  )
}
