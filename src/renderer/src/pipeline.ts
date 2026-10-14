/**
 * 渲染管线钩子（docs/04 §五 · 三级钩子位）——A4 问题（渲染管线封闭）的消解点。
 * 三级：
 *  1. registerMarkdownPlugin：markdown-it 插件位（语法扩展/inline 规则/core 规则）
 *  2. registerPostProcessor：DOM 后处理位（innerHTML 写入后的增强）
 *  3. registerCodeBlockProcessor：自定义 ```lang 代码块处理器
 * 内置能力（KaTeX/任务列表/脚注/callout/图片重写/Mermaid）全部经同一公开 API 注册——吃自己的狗粮。
 */
import type MarkdownIt from 'markdown-it'

export interface RenderContext {
  filePath: string | null
  baseDir: string | null
  /** Host-only cancellation check; never sent to an external plugin. */
  isCurrent?: () => boolean
}

export type MarkdownPluginHook = (md: MarkdownIt) => void
export type PostProcessorHook = (container: HTMLElement, ctx: RenderContext) => void | Promise<void>
export type CodeBlockProcessor = (pre: HTMLElement, source: string, ctx: RenderContext) => void | Promise<void>

const markdownPlugins: MarkdownPluginHook[] = []
/** 语法层注册变更计数：宿主据此重建 markdown-it 实例 */
let markdownRevision = 0
export function getMarkdownRevision(): number {
  return markdownRevision
}
const postProcessors: PostProcessorHook[] = []
let earlyProcessorCount = 0
const codeBlockProcessors = new Map<string, CodeBlockProcessor>()

export function registerMarkdownPlugin(fn: MarkdownPluginHook): void {
  markdownPlugins.push(fn)
  markdownRevision++
}

export function registerPostProcessor(fn: PostProcessorHook, beforeBuiltins = false): void {
  if (beforeBuiltins) postProcessors.splice(earlyProcessorCount++, 0, fn)
  else postProcessors.push(fn)
}

export function registerCodeBlockProcessor(lang: string, fn: CodeBlockProcessor): void {
  if (codeBlockProcessors.has(lang.toLowerCase())) throw new Error(`代码块处理器已注册：${lang}`)
  codeBlockProcessors.set(lang.toLowerCase(), fn)
}

export function unregisterCodeBlockProcessor(lang: string, expected?: CodeBlockProcessor): void {
  if (!expected || codeBlockProcessors.get(lang.toLowerCase()) === expected) codeBlockProcessors.delete(lang.toLowerCase())
}

export function applyMarkdownPlugins(md: MarkdownIt): void {
  for (const fn of [...markdownPlugins]) {
    try { fn(md) } catch (err) { console.error('[pipeline] Markdown 扩展失败', err) }
  }
}

export function listPostProcessors(): PostProcessorHook[] {
  return [...postProcessors]
}

export function getCodeBlockProcessor(lang: string): CodeBlockProcessor | undefined {
  return codeBlockProcessors.get(lang.toLowerCase())
}

export function removeMarkdownPlugin(fn: MarkdownPluginHook): void {
  const i = markdownPlugins.indexOf(fn)
  if (i >= 0) {
    markdownPlugins.splice(i, 1)
    markdownRevision++
  }
}

export function removePostProcessor(fn: PostProcessorHook): void {
  const i = postProcessors.indexOf(fn)
  if (i >= 0) {
    if (i < earlyProcessorCount) earlyProcessorCount--
    postProcessors.splice(i, 1)
  }
}
