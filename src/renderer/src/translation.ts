import { element } from './toolDialog'
import { openServiceSettings } from './serviceSettings'
import { createModelSession } from './modelClient'
import { placeSelectionSurface, applyModelResult, type ModelSelection } from './modelSelection'
import { surfaceButton as button, modelConnectionLabel, copyModelText } from './modelSurface'
import type { DocumentToolsContext } from './documentTools'
import { openTranslationSettings } from './translationSettings'

export function translationPopover(ctx: DocumentToolsContext, source: ModelSelection, onClose: () => void, explain?: () => void, task = createModelSession()) {
  const node = element('section', '', 'translation-popover')
  node.setAttribute('role', 'dialog'); node.setAttribute('aria-label', '划词翻译'); node.tabIndex = -1
  let disposed = false, pending = false, applying = false, output = '', successful = false
  const close = () => { if (disposed) return; disposed = true; task.dispose(); off(); node.remove(); onClose() }
  const header = element('header', '', 'model-surface-header'); header.append(element('strong', '划词翻译')); button('关闭', close, header)
  const lang = element('select'); lang.setAttribute('aria-label', '翻译目标语言')
  for (const value of ['简体中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español']) lang.append(element('option', value))
  try { lang.value = localStorage.getItem('inkleaf:translation-language') || '简体中文' } catch { /* defaults */ }
  if (!lang.value) lang.value = '简体中文'
  const info = element('p', '', 'model-connection'), off = modelConnectionLabel(info)
  const quote = element('details', '', 'model-source'); quote.append(element('summary', `原文 · ${source.text.length} 字`), element('blockquote', source.text))
  const result = element('div', '', 'translation-result'); result.setAttribute('aria-label', '翻译结果')
  const status = element('p', '点击翻译，仅发送此处选文。', 'model-status'); status.setAttribute('role', 'status')
  const actions = element('div', '', 'model-surface-actions')
  const send = button('翻译', () => void translate(), actions), stop = button('停止', () => task.cancel(), actions)
  const copy = button('复制译文', () => copyModelText(output, status), actions)
  const replace = button('替换选文', () => void apply(), actions)
  button('模型连接', () => openServiceSettings('model'), actions)
  button('划词设置', openTranslationSettings, actions)
  if (explain) button('在侧栏解释', () => { close(); explain() }, actions)
  const update = () => { send.disabled = pending || applying || source.text.length > 20000; stop.disabled = !pending; copy.disabled = !output; replace.disabled = pending || applying || !successful || !source.applicable; lang.disabled = pending || applying }
  const translate = async () => {
    if (pending || applying || source.text.length > 20000) return
    if (ctx.path() !== source.path) { close(); return }
    pending = true; successful = false; output = ''; result.textContent = '正在翻译…'; status.textContent = '正在生成…'; update()
    try {
      try { localStorage.setItem('inkleaf:translation-language', lang.value) } catch { /* optional preference */ }
      output = await task.run({ action: 'translate', text: source.text, language: lang.value }, text => { output = text; result.textContent = text; placeSelectionSurface(node, source.rect) })
      if (!disposed) { result.textContent = output; successful = true; status.textContent = '已完成。译文请核对后使用。'; placeSelectionSurface(node, source.rect) }
    } catch (e) { if (!disposed) { status.textContent = e instanceof Error ? e.message : '翻译失败，请重试'; if (!output) result.textContent = '' } }
    finally { pending = false; if (!disposed) update() }
  }
  const apply = async () => {
    if (pending || applying || !successful) return
    applying = true; update()
    try { await applyModelResult(ctx, source, output, true); successful = false; status.textContent = '已替换，原文可在历史中恢复。' }
    catch (e) { status.textContent = e instanceof Error ? e.message : '写入失败，译文已保留' }
    finally { applying = false; if (!disposed) update() }
  }
  lang.onchange = () => { successful = false; update(); status.textContent = '目标语言已更改，点击翻译重新生成。' }
  node.append(header, info, lang, quote, result, actions, status); document.body.append(node)
  if (source.text.length > 20000) status.textContent = '选文超过 20000 字符，请缩小选择范围。'
  update(); placeSelectionSurface(node, source.rect); node.focus()
  if (source.text.length <= 20000) void translate()
  return { close, path: source.path }
}
