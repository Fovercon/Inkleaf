import { input, element, toolDialog } from './toolDialog'
const KEY = 'inkleaf:translation:auto'
export function automaticTranslation() {
  try { return localStorage.getItem(KEY) === 'true' } catch { return false }
}
export function openTranslationSettings() {
  const d = toolDialog('划词翻译设置'), auto = input('选中即译', '', 'checkbox')
  auto.field.checked = automaticTranslation()
  d.body.append(auto.wrap, element('p', '开启后，在阅读视图或编辑器完成划词，将直接把所选文字发送给共用模型并打开翻译浮窗。关闭时只显示翻译与解释操作条，点击后才发送。正在问询时仍使用操作条。', 'tool-hint'))
  d.button('保存设置', () => { localStorage.setItem(KEY, String(auto.field.checked)); d.status.textContent = '已保存，下次选文时生效。' })
}
