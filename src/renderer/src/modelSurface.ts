import { element } from './toolDialog'
export const surfaceButton = (label: string, run: () => void, parent: HTMLElement) => {
  const b = element('button', label); b.type = 'button'; b.onclick = run; parent.append(b); return b
}
export function modelConnectionLabel(node: HTMLElement) {
  let alive = true
  const refresh = () => void window.mdr.serviceSettings().then(s => {
    if (alive) node.textContent = s.endpoint && s.model ? `${s.model} · ${new URL(s.endpoint).host}` : '请先在应用的“模型连接”中配置服务'
  }).catch(() => { if (alive) node.textContent = '模型连接暂不可用' })
  refresh(); window.addEventListener('inkleaf-services-changed', refresh)
  return () => { alive = false; window.removeEventListener('inkleaf-services-changed', refresh) }
}
export function copyModelText(text: string, status: HTMLElement) {
  void navigator.clipboard.writeText(text).then(() => { if (status.isConnected) status.textContent = '已复制' }).catch(() => { if (status.isConnected) status.textContent = '复制失败，请手动选择复制' })
}
