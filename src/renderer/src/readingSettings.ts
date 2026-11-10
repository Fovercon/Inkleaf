import { getState, saveState } from './state'
import { toolDialog, element, input } from './toolDialog'

export function applyReadingSettings() {
  const state = getState(), pane = document.getElementById('preview-pane')!
  pane.style.setProperty('--reading-max-width', state.readingFit ? 'none' : `${state.readingWidth}px`)
  pane.style.setProperty('--reading-padding', `${state.readingPadding}px`)
}

export function openReadingSettings() {
  const d = toolDialog('阅读排版'), state = getState()
  d.dialog.classList.add('reading-settings')
  d.body.append(element('p', '调整即时生效，自动保存在本机。', 'tool-hint'))
  const mode = element('select'); mode.setAttribute('aria-label', '正文宽度模式')
  for (const [value, label] of [['fixed', '限制最大宽度'], ['fit', '铺满阅读区域']]) {
    const option = element('option', label); option.value = value; mode.append(option)
  }
  mode.value = state.readingFit ? 'fit' : 'fixed'
  const label = element('label', '正文宽度模式', 'tool-field'); label.append(mode); d.body.append(label)
  const width = input('最大宽度（像素）', '', 'range')
  width.field.min = '640'; width.field.max = '1600'; width.field.step = '20'
  const padding = input('左右留白（像素）', '', 'range')
  padding.field.min = '12'; padding.field.max = '64'; padding.field.step = '2'
  const widthValue = element('output'), paddingValue = element('output')
  width.wrap.classList.add('reading-range'); padding.wrap.classList.add('reading-range')
  width.wrap.append(widthValue); padding.wrap.append(paddingValue); d.body.append(width.wrap, padding.wrap)
  const presets = element('div', '', 'reading-presets')
  const presetButtons = new Map<number, HTMLButtonElement>()
  d.body.append(element('div', '宽度预设', 'reading-caption'), presets)
  const refresh = () => {
    mode.value = state.readingFit ? 'fit' : 'fixed'
    width.field.value = String(state.readingWidth)
    padding.field.value = String(state.readingPadding)
    width.field.disabled = state.readingFit; widthValue.textContent = `${state.readingWidth} px`
    paddingValue.textContent = `${state.readingPadding} px`
    for (const [n, button] of presetButtons) button.setAttribute('aria-pressed', String(!state.readingFit && n === state.readingWidth))
  }
  const commit = () => { refresh(); applyReadingSettings(); saveState() }
  mode.onchange = () => { state.readingFit = mode.value === 'fit'; commit() }
  width.field.oninput = () => { state.readingWidth = width.field.valueAsNumber; commit() }
  padding.field.oninput = () => { state.readingPadding = padding.field.valueAsNumber; commit() }
  for (const n of [800, 1000, 1200]) {
    const button = element('button', `${n} px`)
    button.onclick = () => { state.readingFit = false; state.readingWidth = n; commit() }
    presetButtons.set(n, button); presets.append(button)
  }
  const reset = element('button', '恢复默认', 'reading-reset')
  reset.onclick = () => {
    state.readingWidth = 1000; state.readingFit = false; state.readingPadding = 24
    commit()
  }
  d.footer.querySelector('button')?.classList.add('reading-done')
  d.footer.prepend(reset)
  refresh()
}
