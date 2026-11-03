import { getState, saveState } from './state'
import { toolDialog, element, input } from './toolDialog'

export function applyReadingSettings() {
  const state = getState(), pane = document.getElementById('preview-pane')!
  pane.style.setProperty('--reading-max-width', state.readingFit ? 'none' : `${state.readingWidth}px`)
  pane.style.setProperty('--reading-padding', `${state.readingPadding}px`)
}

export function openReadingSettings() {
  const d = toolDialog('阅读排版'), state = getState()
  d.body.append(element('p', '调整实时生效，并自动保存在这台电脑上。'))
  const mode = element('select'); mode.setAttribute('aria-label', '正文宽度模式')
  for (const [value, label] of [['fixed', '限制最大宽度'], ['fit', '铺满阅读区域']]) {
    const option = element('option', label); option.value = value; mode.append(option)
  }
  mode.value = state.readingFit ? 'fit' : 'fixed'
  const label = element('label', '正文宽度模式', 'tool-field'); label.append(mode); d.body.append(label)
  const width = input('最大宽度（像素）', String(state.readingWidth), 'range')
  width.field.min = '640'; width.field.max = '1600'; width.field.step = '20'
  const padding = input('左右留白（像素）', String(state.readingPadding), 'range')
  padding.field.min = '12'; padding.field.max = '64'; padding.field.step = '2'
  const widthValue = element('output'), paddingValue = element('output')
  width.wrap.append(widthValue); padding.wrap.append(paddingValue); d.body.append(width.wrap, padding.wrap)
  const refresh = () => {
    width.field.disabled = state.readingFit; widthValue.textContent = `${state.readingWidth} px`
    paddingValue.textContent = `${state.readingPadding} px`; applyReadingSettings(); saveState()
  }
  mode.onchange = () => { state.readingFit = mode.value === 'fit'; refresh() }
  width.field.oninput = () => { state.readingWidth = Number(width.field.value); refresh() }
  padding.field.oninput = () => { state.readingPadding = Number(padding.field.value); refresh() }
  const presets = element('div', '', 'tool-actions'); d.body.append(presets)
  for (const n of [800, 1000, 1200]) d.button(`${n} px`, () => {
    state.readingFit = false; state.readingWidth = n; mode.value = 'fixed'; width.field.value = String(n); refresh()
  }, presets)
  d.button('恢复默认', () => {
    state.readingWidth = 1000; state.readingFit = false; state.readingPadding = 24
    mode.value = 'fixed'; width.field.value = '1000'; padding.field.value = '24'; refresh()
  })
  refresh()
}
