/**
 * 面板注册表（docs/04 §五 L4 / §十 步骤 3）——侧栏/右栏面板的声明式注册。
 * 内置面板与（未来的）插件面板在此同源：A3 问题（面板写死 DOM + applyLayout 逐一操作）的消解点。
 * 编辑器/预览不属于侧栏面板体系，仍由总装的专用逻辑管理。
 */
import type { PaneKey } from './state'

export type PanelSlot = 'left' | 'right'

export interface PanelDef {
  /** 对应 UiState.collapsed / widths 的键 */
  id: PaneKey | string
  slot: PanelSlot
  el: HTMLElement
  resizer: HTMLElement
  min: number
  max: number
  defaultWidth: number
  /** 面板特有的布局副作用（如 sidebar 的边缘把手） */
  onLayout?: (collapsed: boolean) => void
}

const panels = new Map<string, PanelDef>()

export function registerPanel(def: PanelDef): void {
  panels.set(def.id, def)
}

export function getPanel(id: string): PanelDef | undefined {
  return panels.get(id)
}

export function listPanels(): PanelDef[] {
  return [...panels.values()]
}

/** 通用拖宽：按注册信息为面板挂接 resizer */
export function attachPanelResizers(
  readWidth: (id: string) => number,
  writeWidth: (id: string, w: number) => void,
  onEnd: () => void,
) {
  for (const p of panels.values()) {
    p.resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = p.el.getBoundingClientRect().width
      p.resizer.setPointerCapture(e.pointerId)
      p.resizer.classList.add('active')
      const move = (ev: PointerEvent) => {
        const w = Math.round(Math.min(p.max, Math.max(p.min, startW + ev.clientX - startX)))
        p.el.style.width = `${w}px`
      }
      const up = () => {
        p.resizer.releasePointerCapture(e.pointerId)
        p.resizer.removeEventListener('pointermove', move)
        p.resizer.removeEventListener('pointerup', up)
        p.resizer.classList.remove('active')
        writeWidth(p.id, Math.round(p.el.getBoundingClientRect().width))
        onEnd()
      }
      p.resizer.addEventListener('pointermove', move)
      p.resizer.addEventListener('pointerup', up)
    })
  }
}
