import { element } from './toolDialog'
import { openServiceSettings } from './serviceSettings'
import { createModelSession } from './modelClient'
import { applyModelResult, type ModelSelection } from './modelSelection'
import { renderModelMarkdown } from './modelMarkdown'
import { surfaceButton as button, modelConnectionLabel, copyModelText } from './modelSurface'
import type { DocumentToolsContext } from './documentTools'
import type { ModelMessage } from '../../shared/services'

export function modelChatPanel(ctx: DocumentToolsContext, source: ModelSelection, action: 'explain' | 'summarize', onClose: () => void, task = createModelSession()) {
  const node = element('aside', '', 'ai-chat-panel'); node.id = 'ai-chat-panel'; node.setAttribute('aria-label', 'AI 问询侧栏')
  let disposed = false, pending = false, history: ModelMessage[] = [], lastOutput = '', lastSuccess = false, applying = false
  let renderTimer: ReturnType<typeof setTimeout> | undefined
  const header = element('header', '', 'model-surface-header'), title = element('div')
  title.append(element('strong', 'AI 问询'), element('small', '围绕这段文字，继续想一想')); header.append(title)
  const fresh = button('新对话', () => { if (!pending && !applying) { history = []; lastOutput = ''; lastSuccess = false; messages.replaceChildren(); status.textContent = '已清空对话，引用选文保持不变。'; update() } }, header)
  const close = () => { if (disposed) return; disposed = true; task.dispose(); off(); clearTimeout(renderTimer); node.remove(); document.body.classList.remove('ai-chat-open'); window.dispatchEvent(new Event('resize')); onClose() }
  button('关闭', close, header)
  const info = element('p', '', 'model-connection'), off = modelConnectionLabel(info)
  const quote = element('details', '', 'model-source'); quote.append(element('summary', `引用选文 · ${source.text.length} 字 · ${source.path.split('/').pop()}`), element('blockquote', source.text))
  const messages = element('div', '', 'model-messages'); messages.setAttribute('role', 'log'); messages.setAttribute('aria-label', '问询对话')
  const composer = element('div', '', 'model-composer'), question = element('textarea')
  question.setAttribute('aria-label', '向 AI 提问'); question.placeholder = '基于选文提问，或继续追问…'; question.maxLength = 4000; question.rows = 3
  question.value = action === 'summarize' ? '请总结这段选文的主要内容。' : '请解释这段选文中的概念、逻辑与背景。'
  const actions = element('div', '', 'model-surface-actions'), status = element('p', '只发送引用选文与本次对话；生成内容请核对。图片需点击后加载。', 'model-status'); status.setAttribute('role', 'status')
  const send = button('发送', () => void ask(), actions), stop = button('停止', () => { task.cancel(); status.textContent = '正在取消…' }, actions)
  button('模型连接', () => openServiceSettings('model'), actions)
  const copy = button('复制回答', () => copyModelText(lastOutput, status), actions)
  const insert = button('插入选文后', () => void apply(), actions)
  composer.append(question, actions, status); node.append(header, info, quote, messages, composer)
  document.body.append(node); document.body.classList.add('ai-chat-open'); window.dispatchEvent(new Event('resize'))
  const update = () => {
    send.disabled = pending || applying || !question.value.trim() || source.text.length > 20000
    stop.disabled = !pending; copy.disabled = !lastOutput; insert.disabled = pending || applying || !lastSuccess || !source.applicable; fresh.disabled = pending || applying
    question.disabled = pending || applying
  }
  const apply = async () => {
    if (pending || applying || !lastSuccess) return
    applying = true; update()
    try { await applyModelResult(ctx, source, lastOutput, false); lastSuccess = false; status.textContent = '已写入文档，历史中保留原文。' }
    catch (e) { status.textContent = e instanceof Error ? e.message : '文档已变化，回答已保留' }
    finally { applying = false; if (!disposed) update() }
  }
  const ask = async () => {
    if (pending || applying || !question.value.trim() || source.text.length > 20000) return
    if (ctx.path() !== source.path) { close(); return }
    const prompt = question.value.trim(), before = history.slice()
    let trimmed = false
    while (before.length > 18 || before.reduce((n, m) => n + m.content.length, 0) > 40000) { before.splice(0, 2); trimmed = true }
    pending = true; lastSuccess = false; lastOutput = ''; update()
    const user = element('article', '', 'model-message user'); user.append(element('small', '你'), element('p', prompt))
    const answer = element('article', '', 'model-message assistant'), body = element('div', '正在生成…', 'model-answer md-preview')
    answer.append(element('small', '墨页 AI'), body); messages.append(user, answer); messages.scrollTop = messages.scrollHeight
    status.textContent = trimmed ? '较早的对话已从本次上下文中移除。正在生成…' : '正在生成…'
    const paint = () => {
      renderTimer = undefined
      if (!disposed) { const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90; renderModelMarkdown(body, lastOutput); if (nearBottom) messages.scrollTop = messages.scrollHeight }
    }
    try {
      lastOutput = await task.run({ action: 'chat', text: source.text, question: prompt, history: before }, text => { lastOutput = text; if (!renderTimer) renderTimer = setTimeout(paint, 100) })
      if (disposed) return
      clearTimeout(renderTimer); paint(); lastSuccess = true
      history = lastOutput.length <= 20000 ? [...before, { role: 'user', content: prompt }, { role: 'assistant', content: lastOutput }] : []
      question.value = ''; status.textContent = lastOutput.length <= 20000 ? '已完成，可以继续追问。回答仅保留在本次窗口中。' : '已完成。回答较长，下次提问将只使用引用选文，不携带此前对话。'
    } catch (e) {
      if (!disposed) { clearTimeout(renderTimer); paint(); status.textContent = e instanceof Error ? e.message : '请求失败，请重试'; answer.classList.add('incomplete'); if (!lastOutput) body.textContent = '本次未收到回答。可以重试，问题已保留。' }
    } finally { pending = false; if (!disposed) update() }
  }
  question.oninput = update
  question.onkeydown = event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void ask() } }
  if (source.text.length > 20000) status.textContent = '选文超过 20000 字符，请缩小选择范围。'
  update(); question.focus()
  if (source.text.length <= 20000) void ask()
  return { close, path: source.path }
}
