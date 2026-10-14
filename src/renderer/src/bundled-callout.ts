/**
 * Callout 内置插件：通过可信内置插件接口注册提示块语法与交互。
 * 注册内容随插件启用和停用，遵循插件运行时的生命周期。
 */
import { registerBundledPlugin } from './pluginRuntime'
import type MarkdownIt from 'markdown-it'

// Obsidian-compatible callouts: "> [!type] Title" on the first line of a blockquote
const CALLOUT_RE = /^\[!(\w+)\]([+-]?)[ \t]*(.*)$/
const CALLOUT_LABELS: Record<string, string> = {
  note: '📝 备注', abstract: '📋 摘要', summary: '📋 摘要', tldr: '📋 摘要',
  info: 'ℹ️ 信息', todo: '☑️ 待办', tip: '💡 提示', hint: '💡 提示', important: '⭐ 重要',
  success: '✅ 成功', check: '✅ 完成', done: '✅ 完成',
  question: '❓ 问题', help: '❓ 帮助', faq: '❓ 问题',
  warning: '⚠️ 警告', caution: '⚠️ 注意', attention: '⚠️ 注意',
  danger: '🚨 危险', error: '🚨 错误', bug: '🐞 缺陷', example: '📌 示例', quote: '❝ 引用', cite: '❝ 引用',
}

export function registerCalloutPlugin(): void {
  registerBundledPlugin(
    'bundled.callout',
    {
      id: 'bundled.callout',
      name: '提示块（Callout）',
      version: '0.1.0',
      contributes: {},
      permissions: ['render'],
    },
    (ink) => {
      ink.pipeline.registerMarkdownPlugin((md) => {
        const m = md as MarkdownIt
        m.core.ruler.push('mdr_callout', (state) => {
          const tokens = state.tokens
          for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].type !== 'blockquote_open') continue
            if (tokens[i + 1]?.type !== 'paragraph_open') continue
            const inline = tokens[i + 2]
            if (inline?.type !== 'inline' || !inline.children?.length) continue
            const first = inline.children[0]
            if (first.type !== 'text') continue
            const m = CALLOUT_RE.exec(first.content)
            if (!m) continue
            const [, kind, fold, title] = m
            const key = kind.toLowerCase()
            tokens[i].attrJoin('class', 'md-callout')
            tokens[i].attrJoin('class', `md-callout-${key}`)
            tokens[i].attrSet('data-callout-title', title || CALLOUT_LABELS[key] || kind)
            if (fold) tokens[i].attrSet('data-callout-fold', fold)
            first.content = ''
            if (inline.children.length === 1) inline.children.length = 0
            inline.content = ''
          }
        })
      })
    },
  )
}
