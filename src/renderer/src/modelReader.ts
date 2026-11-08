import { registerBundledPlugin, onPluginStateChange, pluginSnapshot, inheritPluginOptOut } from './pluginRuntime'
import { element } from './toolDialog'
import { captureModelSelection, placeSelectionSurface, type ModelSelection } from './modelSelection'
import { surfaceButton as button } from './modelSurface'
import { translationPopover } from './translation'
import { modelChatPanel } from './modelChat'
import { onPreviewRendered } from './preview'
import type { DocumentToolsContext } from './documentTools'
import type { createModelSession } from './modelClient'
import { automaticTranslation, openTranslationSettings } from './translationSettings'

const TRANSLATE = 'bundled.translation', CHAT = 'bundled.ai-chat'
const enabled = (id: string) => pluginSnapshot().some(p => p.id === id && p.state === 'active')
export function registerModelPlugin(ctx: DocumentToolsContext) {
  const sessions = new Map<string, () => ReturnType<typeof createModelSession>>()
  let last: ModelSelection | undefined, toolbar: HTMLElement | undefined
  let lastAuto: ModelSelection | undefined, dragging = false
  let popup: { close(): void; path: string } | undefined, chat: { close(): void; path: string } | undefined
  const clearToolbar = () => { toolbar?.remove(); toolbar = undefined }
  const chosen = () => last?.path === ctx.path() && last.expected === ctx.content() ? last : captureModelSelection(ctx)
  const hint = () => {
    clearToolbar(); const node = element('div', '请先在阅读视图或编辑器中选中文字。', 'selection-actions'); node.setAttribute('role', 'status')
    document.body.append(node); placeSelectionSurface(node, { left: window.innerWidth / 2, top: 100, bottom: 100 }); toolbar = node
    button('关闭', clearToolbar, node)
  }
  const showChat = (source: ModelSelection | undefined, action: 'explain' | 'summarize' = 'explain') => {
    if (!enabled(CHAT)) return
    if (!source) { hint(); return }
    clearToolbar(); popup?.close(); chat?.close()
    chat = modelChatPanel(ctx, source, action, () => { chat = undefined }, sessions.get(CHAT)!())
  }
  const showTranslation = (source: ModelSelection | undefined) => {
    if (!enabled(TRANSLATE)) return
    if (!source) { hint(); return }
    clearToolbar(); popup?.close()
    popup = translationPopover(ctx, source, () => { popup = undefined }, enabled(CHAT) ? () => showChat(source) : undefined, sessions.get(TRANSLATE)!())
  }
  const showTools = (source: ModelSelection) => {
    clearToolbar()
    if (!enabled(TRANSLATE) && !enabled(CHAT)) return
    last = source
    const node = element('div', '', 'selection-actions'); node.setAttribute('role', 'toolbar'); node.setAttribute('aria-label', '选文操作')
    node.onpointerdown = e => { e.preventDefault() }
    if (enabled(TRANSLATE)) button('翻译', () => showTranslation(source), node)
    if (enabled(CHAT)) { button('解释', () => showChat(source), node); button('总结', () => showChat(source, 'summarize'), node) }
    button('收起', clearToolbar, node); document.body.append(node); toolbar = node; placeSelectionSurface(node, source.rect)
  }
  let selectionTimer: ReturnType<typeof setTimeout>
  const readSelection = (editorOnly = false) => {
    if (document.querySelector('dialog[open]')) return
    const source = captureModelSelection(ctx, editorOnly, editorOnly)
    if (source) {
      if (enabled(TRANSLATE) && automaticTranslation() && !chat && !dragging) {
        const same = lastAuto?.path === source.path && lastAuto.expected === source.expected && lastAuto.text === source.text && lastAuto.from === source.from
        if (!same) { lastAuto = source; last = source; showTranslation(source) }
      } else showTools(source)
    } else { last = undefined; lastAuto = undefined; clearToolbar() }
  }
  document.addEventListener('selectionchange', () => {
    const native = window.getSelection(), preview = document.getElementById('preview')
    if (native?.anchorNode && preview?.contains(native.anchorNode) && !dragging) { clearTimeout(selectionTimer); selectionTimer = setTimeout(() => readSelection(), 180) }
    else if (native?.isCollapsed) clearToolbar()
  })
  for (const event of ['pointerup', 'keyup']) document.getElementById('editor-pane')!.addEventListener(event, () => { clearTimeout(selectionTimer); selectionTimer = setTimeout(() => readSelection(true), 80) })
  document.addEventListener('pointerdown', e => {
    const target = e.target as Element
    if (target.closest('#preview, #editor-pane')) { dragging = true; lastAuto = undefined; clearTimeout(selectionTimer) }
    if (!target.closest('.selection-actions, .translation-popover, .ai-chat-panel, dialog')) { clearToolbar(); popup?.close() }
  })
  document.addEventListener('pointerup', event => {
    if (!dragging) return
    dragging = false; clearTimeout(selectionTimer)
    selectionTimer = setTimeout(() => readSelection(!!(event.target as Element).closest('#editor-pane')), 180)
  })
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { if (popup) popup.close(); else if (toolbar) clearToolbar(); else chat?.close() } })
  const invalidate = () => {
    if (last && (last.path !== ctx.path() || last.expected !== ctx.content())) { last = undefined; clearToolbar() }
    if (popup && popup.path !== ctx.path()) popup.close()
    if (chat && chat.path !== ctx.path()) chat.close()
  }
  onPreviewRendered(invalidate)
  window.addEventListener('inkleaf-document-changed', invalidate)
  window.addEventListener('resize', () => { clearToolbar(); popup?.close() })
  document.getElementById('preview-scroll')!.addEventListener('scroll', () => { clearToolbar(); popup?.close() }, { passive: true })
  onPluginStateChange(() => { clearToolbar(); if (!enabled(TRANSLATE)) popup?.close(); if (!enabled(CHAT)) chat?.close() })
  inheritPluginOptOut('bundled.ai-reader', [TRANSLATE, CHAT])
  for (const translation of [true, false]) {
    const id = translation ? TRANSLATE : CHAT
    registerBundledPlugin(id, { id, name: translation ? '划词翻译' : 'AI 问询', version: '1.0.0', author: 'Inkleaf', category: '阅读',
      description: translation ? '选中文字，就近打开翻译浮窗；支持多语言、复制和安全替换。' : '围绕选文在右侧解释、总结与连续追问，支持 Markdown、公式和按需加载图片。',
      usage: '使用应用级“模型连接”，无需重复配置。阅读视图和编辑器均可选文，点击选文工具条。仅主动请求时发送选文；停用本插件不会移除连接或影响其他 AI 功能。',
      permissions: ['commands', 'model'], contributes: { commands: translation ? [{ id: `${id}.translate`, title: '翻译选中文字' }, { id: `${id}.settings`, title: '划词翻译设置…' }] : [{ id: `${id}.explain`, title: '解释选中文字' }, { id: `${id}.summarize`, title: '总结选中文字' }] },
      changelog: [{ version: '1.0.0', notes: '从选文助手拆分，共用应用级模型连接。' }],
    }, ink => {
      sessions.set(id, () => ink.model.createSession())
      if (translation) {
        ink.commands.register({ id: `${id}.translate`, title: '翻译选中文字', run: () => showTranslation(chosen()) })
        ink.commands.register({ id: `${id}.settings`, title: '划词翻译设置…', run: openTranslationSettings })
      }
      else for (const action of ['explain', 'summarize'] as const) ink.commands.register({ id: `${id}.${action}`, title: `${action === 'explain' ? '解释' : '总结'}选中文字`, run: () => showChat(chosen(), action) })
    })
  }
}
