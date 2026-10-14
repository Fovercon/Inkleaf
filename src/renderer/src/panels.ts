/**
 * 面板注册表：声明式注册左侧和右侧面板，统一管理宽度、折叠与布局。
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
  /** 与另一面板共享宽度（右栏堆叠面板）：不设自身宽度，随容器铺满 */
  sharesWidth?: string
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
  const wired = new Set<HTMLElement>()
  for (const p of panels.values()) {
    if (wired.has(p.resizer)) continue // 多面板共享同一 resizer 时只挂一次
    wired.add(p.resizer)
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
