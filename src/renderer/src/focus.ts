/**
 * 专注模式与打字机滚动（docs/02 快速赢 · 对标 Typora）。
 * - focus：预览侧高亮视口中部块级元素、其余淡出；编辑器侧高亮当前行（basicSetup 已带 activeLine）。
 * - typewriter：输入时保持光标垂直居中（由 EditorPane 实现，这里只管开关与持久化）。
 */
import { getState, saveState } from './state'

export function applyFocusModes() {
  const s = getState()
  document.body.classList.toggle('focus-mode', s.focusMode)
  document.body.classList.toggle('typewriter-mode', s.typewriter)
}

export function toggleFocusMode() {
  const s = getState()
  s.focusMode = !s.focusMode
  saveState()
  applyFocusModes()
}

export function toggleTypewriter() {
  const s = getState()
  s.typewriter = !s.typewriter
  saveState()
  applyFocusModes()
}

/** 在预览容器上标记"当前阅读位置"的块级元素（仅在专注模式下产生视觉差） */
export function setupFocusHighlight(scroller: HTMLElement, container: HTMLElement) {
  let active: Element | null = null
  const mark = () => {
    if (!getState().focusMode) return
    const mid = scroller.getBoundingClientRect().top + scroller.clientHeight / 2
    let target: Element | null = null
    for (const el of container.children) {
      if (el instanceof HTMLElement && el.getBoundingClientRect().top <= mid) target = el
      else break
    }
    if (target === active) return
    active?.classList.remove('focus-active')
    active = target
    active?.classList.add('focus-active')
  }
  scroller.addEventListener('scroll', () => requestAnimationFrame(mark), { passive: true })
  mark()
}
