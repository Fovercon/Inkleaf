import DOMPurify from 'dompurify'
import { registerBundledPlugin } from './pluginRuntime'
import { openServiceSettings } from './serviceSettings'
import { element } from './toolDialog'
import type { RenderContext } from './pipeline'

let worker: Worker | undefined, serial = Promise.resolve(), id = 0
const cache = new Map<string, string>(), plantCache = new Map<string, string>()
let plantSerial = Promise.resolve(), plantRevision = 0
function dot(source: string, isCurrent?: () => boolean): Promise<string> {
  if (source.length > 30000) return Promise.reject(new Error('图表超过 30000 个字符，请拆分后阅读'))
  const cached = cache.get(source); if (cached) return Promise.resolve(cached)
  const operation = serial.then(() => new Promise<string>((resolve, reject) => {
    if (isCurrent && !isCurrent()) { reject(new Error('图表渲染已过期')); return }
    worker ??= new Worker(new URL('diagram-worker.js', document.baseURI), { type: 'module' })
    const current = worker, job = ++id
    const cleanup = () => { clearTimeout(timer); current.removeEventListener('message', message); current.removeEventListener('error', failure) }
    const failure = () => { cleanup(); current.terminate(); if (worker === current) worker = undefined; reject(new Error('图表引擎无法启动，请重新打开文档')) }
    const message = (event: MessageEvent) => {
      if (event.data.id !== job) return
      cleanup()
      if (typeof event.data.svg === 'string') { if (cache.size >= 24) cache.delete(cache.keys().next().value!); cache.set(source, event.data.svg); resolve(event.data.svg) }
      else reject(new Error(event.data.error || '图表渲染失败'))
    }
    const timer = setTimeout(() => { cleanup(); current.terminate(); if (worker === current) worker = undefined; reject(new Error('图表渲染超时，请简化图表')) }, 15000)
    current.addEventListener('message', message); current.addEventListener('error', failure); current.postMessage({ id: job, source })
  }))
  serial = operation.then(() => {}, () => {}); return operation
}
function plant(source: string, isCurrent?: () => boolean): Promise<string> {
  const revision = plantRevision
  const cached = plantCache.get(source); if (cached) return Promise.resolve(cached)
  const operation = plantSerial.then(async () => {
    if (isCurrent && !isCurrent()) throw new Error('图表渲染已过期')
    const existing = plantCache.get(source); if (existing) return existing
    const svg = await window.mdr.renderPlantuml(source)
    if (revision === plantRevision) {
      if (plantCache.size >= 24) plantCache.delete(plantCache.keys().next().value!)
      plantCache.set(source, svg)
    }
    return svg
  })
  plantSerial = operation.then(() => {}, () => {}); return operation
}
/** SVG is display-only: no links, foreign HTML, scripts, remote fonts or images. */
export function safeDiagram(svg: string): SVGElement {
  if (svg.length > 2 * 1024 * 1024) throw new Error('图表输出过大')
  const clean = DOMPurify.sanitize(svg, {
    ALLOWED_TAGS: ['svg', 'g', 'path', 'ellipse', 'circle', 'rect', 'polygon', 'polyline', 'line', 'text', 'tspan', 'title', 'desc', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath'],
    ALLOWED_ATTR: ['xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'dx', 'dy', 'cx', 'cy', 'rx', 'ry', 'r', 'd', 'points', 'transform', 'fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'textLength', 'lengthAdjust', 'dominant-baseline', 'style', 'id', 'offset', 'stop-color', 'stop-opacity'],
    RETURN_DOM_FRAGMENT: true,
  })
  const allowedStyles = new Set(['fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor'])
  for (const node of clean.querySelectorAll<SVGElement>('*')) {
    for (const attribute of [...node.attributes]) {
      if (attribute.name === 'xmlns') continue
      if (/\\|\/\*|url\s*\(|(?:https?|data|javascript):|@import|var\s*\(/i.test(attribute.value)) node.removeAttribute(attribute.name)
    }
    if (node.hasAttribute('style')) {
      for (const name of [...node.style]) if (!allowedStyles.has(name)) node.style.removeProperty(name)
    }
  }
  const result = clean.querySelector('svg')
  if (!result || !result.querySelector('path,rect,ellipse,circle,text,line,polygon,polyline')) throw new Error('服务未返回有效 SVG 图表')
  result.setAttribute('role', 'img'); result.setAttribute('aria-label', '代码图表'); return result
}
async function renderDiagram(pre: HTMLElement, source: string, ctx: RenderContext, plantuml: boolean) {
  if (ctx.isCurrent && !ctx.isCurrent()) return
  const hint = element('p', plantuml ? '正在渲染 PlantUML…' : '正在渲染 Graphviz…', 'diagram-status')
  pre.after(hint)
  try {
    const svg = safeDiagram(await (plantuml ? plant(source, ctx.isCurrent) : dot(source, ctx.isCurrent)))
    if ((ctx.isCurrent && !ctx.isCurrent()) || !pre.isConnected) { hint.remove(); return }
    const figure = element('figure', '', 'code-diagram'); figure.append(svg)
    if (pre.dataset.sourceLine) { figure.dataset.sourceLine = pre.dataset.sourceLine; delete pre.dataset.sourceLine }
    const details = element('details'), summary = element('summary', '查看图表源码'); details.append(summary)
    pre.replaceWith(figure); details.append(pre); figure.append(details); hint.remove()
  } catch (error) {
    if ((ctx.isCurrent && !ctx.isCurrent()) || !pre.isConnected) { hint.remove(); return }
    hint.textContent = error instanceof Error ? error.message : '图表渲染失败，已保留源码'
    hint.classList.add('error')
    if (plantuml) { const button = element('button', '配置 PlantUML 服务'); button.onclick = () => openServiceSettings('diagram'); hint.append(' ', button) }
  }
}
export function registerDiagramPlugins(onChange: () => void) {
  const changed = () => { plantRevision++; plantCache.clear(); onChange() }
  window.addEventListener('inkleaf-services-changed', event => {
    if (event instanceof CustomEvent && event.detail?.section === 'model') return
    changed()
  })
  for (const plantuml of [false, true]) {
    const id = plantuml ? 'bundled.plantuml' : 'bundled.graphviz'
    const command = `${id}.settings`
    registerBundledPlugin(id, { id, name: plantuml ? 'PlantUML 图表' : 'Graphviz 图表', version: plantuml ? '1.1.0' : '1.0.0', author: 'Inkleaf', category: '图表',
      description: plantuml ? '渲染 PlantUML 图表，内置官方和 Kroki 免费服务预设，也可连接本机服务。' : '离线渲染 DOT 流程、依赖、结构和算法图。',
      usage: plantuml ? '使用 plantuml 或 puml 围栏。在图表服务中选择官方 / Kroki 免费服务或填写本机地址，保存后代码将发送给所选服务。未配置时保留源码；不支持外部 include/import。' : '使用 dot 或 graphviz 围栏，无需网络。大图或语法错误会保留源码。',
      examples: [{ title: '基础示例', markdown: plantuml ? '```plantuml\n@startuml\nAlice -> Bob: Hello\nBob --> Alice: OK\n@enduml\n```' : '```dot\ndigraph { Start -> Check; Check -> Done [label="yes"]; Check -> Start [label="retry"]; }\n```' }],
      changelog: [...(plantuml ? [{ version: '1.1.0', notes: '官方与 Kroki 免费服务预设、独立协议、固定样例连接测试。' }] : []), { version: '1.0.0', notes: '首次支持图表渲染、净化 SVG、错误提示和查看源码。' }],
      contributes: { commands: [{ id: command, title: '图表服务设置…' }] }, permissions: ['render', 'commands'],
    }, ink => {
      ink.commands.register({ id: command, title: '图表服务设置…', run: () => openServiceSettings('diagram') })
      for (const lang of plantuml ? ['plantuml', 'puml'] : ['dot', 'graphviz']) ink.pipeline.registerCodeBlockProcessor(lang, (pre, source, ctx) => { void renderDiagram(pre, source, ctx, plantuml) })
    })
  }
}
