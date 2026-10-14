/** 渲染层共享的文本转义与路径格式化工具。 */

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
