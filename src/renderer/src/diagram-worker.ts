import { instance } from '@viz-js/viz'
const engine = instance()
self.onmessage = async (event: MessageEvent<{ id: number; source: string }>) => {
  const { id, source } = event.data
  try {
    const viz = await engine
    const svg = viz.renderString(source, { format: 'svg', engine: 'dot' })
    if (svg.length > 2 * 1024 * 1024) throw new Error('图表输出过大，请拆分图表')
    self.postMessage({ id, svg })
  } catch { self.postMessage({ id, error: 'Graphviz 无法渲染，请检查 DOT 语法或简化图表' }) }
}
