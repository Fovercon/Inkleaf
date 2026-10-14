/** 渲染层共享小工具（A8 清理：消除三处重复定义） */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function baseName(p: string): string {
  return p.split('/').pop() ?? p
}

export function stripMdExt(p: string): string {
  return baseName(p).replace(/\.(md|markdown|mdx)$/i, '')
}
