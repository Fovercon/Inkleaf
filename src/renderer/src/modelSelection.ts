import type { DocumentToolsContext } from './documentTools'

export interface ModelSelection {
  path: string; expected: string; text: string; from: number; to: number; applicable: boolean
  rect: { left: number; bottom: number; top: number }
}
export function captureModelSelection(ctx: DocumentToolsContext, editorOnly = false, allowEditor = true): ModelSelection | undefined {
  const path = ctx.path(); if (!path) return
  const expected = ctx.content(), native = window.getSelection(), preview = document.getElementById('preview')
  if (!editorOnly && native?.rangeCount && !native.isCollapsed && preview?.contains(native.anchorNode) && preview.contains(native.focusNode)) {
    const text = native.toString().trim(); if (!text) return
    const from = expected.indexOf(text), rect = native.getRangeAt(0).getBoundingClientRect()
    return { path, expected, text, from, to: from + text.length, applicable: from >= 0 && expected.indexOf(text, from + 1) < 0, rect }
  }
  if (!allowEditor || !document.getElementById('editor-pane')?.getClientRects().length) return
  const { from, to } = ctx.selection()
  if (from === to) return
  const rect = ctx.selectionRect?.() ?? document.getElementById('editor-pane')!.getBoundingClientRect()
  return { path, expected, text: expected.slice(from, to), from, to, applicable: true, rect }
}
export function placeSelectionSurface(node: HTMLElement, rect: ModelSelection['rect']) {
  const margin = 12, box = node.getBoundingClientRect()
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - box.width - margin))
  const below = rect.bottom + 8
  node.style.left = `${left}px`
  node.style.top = `${Math.max(margin, Math.min(below + box.height <= window.innerHeight - margin ? below : rect.top - box.height - 8, window.innerHeight - box.height - margin))}px`
}
export async function applyModelResult(ctx: DocumentToolsContext, selected: ModelSelection, output: string, replacing: boolean) {
  if (!selected.applicable) throw new Error('选文无法对应唯一源码位置，请复制结果或在编辑器重新选择')
  const eol = selected.expected.includes('\r\n') ? '\r\n' : '\n', text = output.replace(/\r?\n/g, eol)
  const next = replacing ? selected.expected.slice(0, selected.from) + text + selected.expected.slice(selected.to)
    : selected.expected.slice(0, selected.to) + eol + eol + text + selected.expected.slice(selected.to)
  await ctx.edit(selected.path, selected.expected, next)
}
