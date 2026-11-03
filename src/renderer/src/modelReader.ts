import { registerBundledPlugin } from './pluginRuntime'
import { element, toolDialog } from './toolDialog'
import { openServiceSettings } from './serviceSettings'
import type { DocumentToolsContext } from './documentTools'
import type { ModelAction } from '../../shared/services'

const labels: Record<ModelAction, string> = { explain: '解释', translate: '翻译', summarize: '总结' }
interface Selection { path: string; expected: string; text: string; from: number; to: number; applicable: boolean }
let lastPreview: Selection | undefined
function capture(ctx: DocumentToolsContext): Selection | undefined {
  const selected = window.getSelection(), preview = document.getElementById('preview'), path = ctx.path()
  if (!path || !selected?.rangeCount || selected.isCollapsed || !preview?.contains(selected.anchorNode) || !preview.contains(selected.focusNode)) return
  const text = selected.toString().trim(), expected = ctx.content()
  if (!text) return
  const from = expected.indexOf(text), unique = from >= 0 && expected.indexOf(text, from + 1) < 0
  return { path, expected, text, from, to: from + text.length, applicable: unique }
}
function selection(ctx: DocumentToolsContext): Selection | undefined {
  const native = capture(ctx); if (native) return native
  const path = ctx.path(), expected = ctx.content(), { from, to } = ctx.selection()
  if (lastPreview?.path === path && lastPreview.expected === expected) return lastPreview
  if (path && from !== to) return { path, expected, from, to, text: expected.slice(from, to), applicable: true }
}
export function openModelReader(ctx: DocumentToolsContext, action: ModelAction = 'explain') {
  const chosen = selection(ctx), d = toolDialog('选文助手', true)
  let activeId = '', pending = false, applying = false, output = '', successful = false, disposed = false
  const actions = element('select'); actions.setAttribute('aria-label', '选文操作')
  for (const value of ['explain', 'translate', 'summarize'] as const) { const option = element('option', labels[value]); option.value = value; actions.append(option) }
  actions.value = action
  const language = element('select'); language.setAttribute('aria-label', '翻译目标语言')
  for (const lang of ['简体中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español']) { const option = element('option', lang); option.value = lang; language.append(option) }
  const row = element('div', '', 'tool-row'); row.append(actions, language); d.body.append(row)
  const updateLanguage = () => { language.hidden = actions.value !== 'translate' }; actions.onchange = updateLanguage; updateLanguage()
  const connection = element('p', '正在读取模型配置…', 'tool-hint')
  const quote = element('blockquote', chosen?.text || '请先在阅读视图或编辑器中选中文字，再打开选文助手。', 'model-selection')
  const result = element('pre', '', 'model-result'); result.setAttribute('aria-label', '模型结果'); result.setAttribute('aria-live', 'off')
  d.body.append(connection, quote, result)
  d.body.append(element('p', '仅发送上方选文。模型生成的内容可能不准确，请核对后使用。', 'tool-hint'))
  let configured = false
  void window.mdr.serviceSettings().then(settings => {
    if (disposed) return
    configured = !!settings.endpoint && !!settings.model
    connection.textContent = configured ? `${settings.provider === 'ollama' ? 'Ollama' : '兼容服务'} · ${settings.model} · ${settings.endpoint} · ${chosen?.text.length ?? 0} 字符` : '尚未配置模型连接。请先打开连接设置。'
    updateControls()
  }).catch(() => { if (!disposed) connection.textContent = '无法读取模型设置，请重试' })
  const buttons = element('div', '', 'tool-actions'); d.body.append(buttons)
  const send = element('button', '发送选文'), cancel = element('button', '取消请求'), settings = element('button', '连接设置'), copy = element('button', '复制结果'), insert = element('button', '插入选文后'), replace = element('button', '替换选文')
  buttons.append(send, cancel, settings, copy, insert, replace)
  const updateControls = () => {
    const busy = pending || applying
    send.disabled = busy || !configured || !chosen || chosen.text.length > 20000
    cancel.disabled = !pending; settings.disabled = busy; actions.disabled = busy; language.disabled = busy
    copy.disabled = !output; insert.disabled = replace.disabled = busy || !successful || !chosen?.applicable
  }
  if (chosen && chosen.text.length > 20000) d.status.textContent = '选文超过 20000 个字符，请缩小范围。'
  else if (chosen && !chosen.applicable) d.status.textContent = '选文无法唯一对应源文位置，可复制结果；如需写回，请在编辑器中重新选择。'
  const removeListener = window.mdr.onModelChunk(chunk => {
    if (disposed || !pending || chunk.id !== activeId) return
    output += chunk.text; result.textContent = output
  })
  send.onclick = async () => {
    if (pending || !chosen || !configured) return
    pending = true; successful = false; output = ''; result.textContent = ''; d.status.classList.remove('error'); d.status.textContent = '正在生成…'
    const id = crypto.randomUUID(); activeId = id; updateControls()
    try {
      const text = await window.mdr.runModel({ id, action: actions.value as ModelAction, text: chosen.text, language: language.value })
      if (disposed || activeId !== id) return
      output = text; result.textContent = text; successful = true; d.status.textContent = '已完成。查看结果后，可复制或写回文档。'
    } catch (error) { if (!disposed && activeId === id) { d.status.textContent = error instanceof Error ? error.message : '请求失败，请重试'; d.status.classList.add('error') } }
    finally { if (activeId === id) { pending = false; activeId = ''; if (!disposed) updateControls() } }
  }
  cancel.onclick = () => { if (activeId) { d.status.textContent = '正在取消…'; void window.mdr.cancelModel(activeId) } }
  settings.onclick = () => openServiceSettings('model')
  copy.onclick = () => { void navigator.clipboard.writeText(output).then(() => { d.status.textContent = '已复制结果' }).catch(() => { d.status.textContent = '无法复制，请手动选择结果复制' }) }
  const apply = async (replacing: boolean) => {
    if (!chosen?.applicable || !successful || pending) return
    applying = true; updateControls()
    const eol = chosen.expected.includes('\r\n') ? '\r\n' : '\n'
    const text = output.replace(/\r?\n/g, eol)
    const next = replacing ? chosen.expected.slice(0, chosen.from) + text + chosen.expected.slice(chosen.to) : chosen.expected.slice(0, chosen.to) + eol + eol + text + chosen.expected.slice(chosen.to)
    try { await ctx.edit(chosen.path, chosen.expected, next); successful = false; d.status.textContent = '已写入文档，可在文档历史中恢复。' }
    catch (error) { d.status.textContent = error instanceof Error ? error.message : '写入失败，结果已保留'; d.status.classList.add('error') }
    finally { applying = false; updateControls() }
  }
  insert.onclick = () => void apply(false); replace.onclick = () => void apply(true)
  d.dialog.addEventListener('close', () => { disposed = true; removeListener(); if (activeId) void window.mdr.cancelModel(activeId) }, { once: true })
  updateControls()
}
export function registerModelPlugin(ctx: DocumentToolsContext) {
  document.addEventListener('selectionchange', () => {
    const selected = capture(ctx)
    if (selected) lastPreview = selected
    else if (document.activeElement?.closest('#editor-pane')) lastPreview = undefined
  })
  const id = 'bundled.ai-reader'
  registerBundledPlugin(id, { id, name: '选文助手', version: '1.0.0', author: 'Inkleaf', category: '阅读',
    description: '共用一个模型连接，为选中文字提供解释、翻译和总结。',
    usage: '先在阅读视图或编辑器选中文字，再运行解释、翻译或总结。连接支持兼容 Chat Completions 的服务及本机 Ollama。发送前展示选文与服务地址，结果经你确认后才写回文档。Key 由主进程系统加密保存，外部插件不可读取。',
    changelog: [{ version: '1.0.0', notes: '统一连接设置、流式结果、取消请求、复制与安全写回。' }],
    contributes: { commands: [{ id: `${id}.settings`, title: '模型连接设置…' }, ...Object.entries(labels).map(([action, label]) => ({ id: `${id}.${action}`, title: `${label}选中文字…` }))] }, permissions: ['commands'],
  }, ink => {
    ink.commands.register({ id: `${id}.settings`, title: '模型连接设置…', run: () => openServiceSettings('model') })
    for (const action of Object.keys(labels) as ModelAction[]) ink.commands.register({ id: `${id}.${action}`, title: `${labels[action]}选中文字…`, run: () => openModelReader(ctx, action) })
  })
}
