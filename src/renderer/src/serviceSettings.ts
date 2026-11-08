import { element, input, toolDialog } from './toolDialog'
import type { DiagramProvider } from '../../shared/services'

export function openServiceSettings(section: 'diagram' | 'model' = 'model', changed?: () => void) {
  const d = toolDialog(section === 'diagram' ? '图表服务' : '模型连接 · 应用基础能力')
  void d.run(async () => {
    const settings = await window.mdr.serviceSettings()
    if (!d.dialog.isConnected) return
    const plantuml = input('图表服务根地址', settings.plantumlUrl)
    plantuml.field.placeholder = 'https://www.plantuml.com/plantuml'
    const preset = element('select'); preset.setAttribute('aria-label', '图表服务预设')
    for (const [value, label] of [['official', 'PlantUML 官方 · 免费公共服务'], ['kroki', 'Kroki · 免费公共服务'], ['local', '本机 PlantUML'], ['custom', '自定义服务']]) {
      const option = element('option', label); option.value = value; preset.append(option)
    }
    const protocol = element('select'); protocol.setAttribute('aria-label', '图表服务协议')
    for (const [value, label] of [['plantuml', 'PlantUML 标准服务'], ['kroki', 'Kroki API']]) { const option = element('option', label); option.value = value; protocol.append(option) }
    protocol.value = settings.diagramProvider ?? 'plantuml'
    preset.value = settings.plantumlUrl === 'https://www.plantuml.com/plantuml' ? 'official' : settings.plantumlUrl === 'https://kroki.io' ? 'kroki' : settings.plantumlUrl === 'http://localhost:8080' ? 'local' : 'custom'
    const provider = element('select'); provider.setAttribute('aria-label', '模型连接类型')
    for (const [value, label] of [['compatible', 'OpenAI 兼容服务'], ['ollama', 'Ollama（本机）']]) {
      const option = element('option', label); option.value = value; provider.append(option)
    }
    provider.value = settings.provider
    const providerLabel = element('label', '模型连接类型', 'tool-field'); providerLabel.append(provider)
    const endpoint = input('模型 API 根地址', settings.endpoint)
    endpoint.field.placeholder = '兼容服务：https://你的服务/v1；Ollama：http://localhost:11434'
    const model = input('模型名称', settings.model); model.field.placeholder = '填写服务商提供的模型 ID'
    const key = input('API Key（留空保留，变更地址将清除旧 Key）', '', 'password')
    key.field.autocomplete = 'new-password'; key.field.spellcheck = false
    const remember = input('使用系统加密存储记住 Key', '', 'checkbox')
    remember.field.checked = settings.secureStorage; remember.field.disabled = !settings.secureStorage
    const clear = input('清除已保存的 Key', '', 'checkbox')
    if (section === 'diagram') {
      d.body.append(element('p', 'Mermaid 和 Graphviz 已离线接入，无需服务。PlantUML 可使用下列免费服务，不需要自己开发服务器。', 'tool-hint'))
      const presets = element('label', '选择服务', 'tool-field'); presets.append(preset)
      const protocols = element('label', '服务协议', 'tool-field'); protocols.append(protocol)
      d.body.append(presets, plantuml.wrap, protocols, element('p', '保存后，文档中的 PlantUML 源码会发送到此地址。公共服务不适合保密图表；也可选择本机或自建服务。连接失败不会自动把内容发往另一个服务。', 'tool-hint'))
      preset.onchange = () => {
        const values: Record<string, [string, DiagramProvider]> = { official: ['https://www.plantuml.com/plantuml', 'plantuml'], kroki: ['https://kroki.io', 'kroki'], local: ['http://localhost:8080', 'plantuml'] }
        const value = values[preset.value]; if (value) { plantuml.field.value = value[0]; protocol.value = value[1] }
      }
      plantuml.field.oninput = () => { preset.value = 'custom' }
      if (!settings.plantumlUrl) { preset.value = 'official'; preset.dispatchEvent(new Event('change')) }
      d.button('停用联网图表', async () => { plantuml.field.value = ''; await save(); d.status.textContent = '已停用联网图表。Graphviz 和 Mermaid 仍可离线使用。' })
    } else {
      d.body.append(element('p', '这是应用的共用能力。划词翻译、AI 问询及后续内置功能使用同一连接，停用插件不会删除配置。仅主动请求时发送选文与当前对话。', 'tool-hint'), providerLabel, endpoint.wrap, model.wrap, key.wrap, remember.wrap, clear.wrap)
      d.body.append(element('p', settings.hasKey ? `已有 Key：${settings.keyStorage === 'encrypted' ? '系统加密保存' : '仅本次会话有效'}。` : '尚未设置 Key。本机 Ollama 通常不需要 Key。', 'tool-hint'))
      if (!settings.secureStorage) d.body.append(element('p', '系统加密存储不可用，Key 仅在本次运行中保留，退出后需重新输入。', 'tool-hint'))
    }
    provider.onchange = () => { endpoint.field.value = provider.value === 'ollama' ? 'http://localhost:11434' : ''; key.field.value = ''; model.field.value = '' }
    const save = async () => {
      const next = await window.mdr.saveServiceSettings({ scope: section, plantumlUrl: plantuml.field.value.trim(), diagramProvider: protocol.value as DiagramProvider, provider: provider.value as 'compatible' | 'ollama', endpoint: endpoint.field.value.trim(), model: model.field.value.trim(), key: key.field.value || undefined, clearKey: clear.field.checked, rememberKey: remember.field.checked })
      key.field.value = ''; d.status.classList.remove('error')
      window.dispatchEvent(new CustomEvent('inkleaf-services-changed', { detail: { section } })); changed?.()
      d.status.textContent = section === 'diagram' ? '已保存，当前文档将重新渲染。' : `已保存共用连接。${next.hasKey && next.keyStorage === 'session' ? 'Key 仅在本次会话有效。' : ''}选中文字即可翻译或问询。`
    }
    d.button('保存设置', save)
    if (section === 'diagram') d.button('测试连接', async () => {
      if (!plantuml.field.value.trim()) throw new Error('请先选择图表服务')
      // Test unsaved values against a fixed sample, without updating configuration or preview.
      await window.mdr.testDiagramService({ url: plantuml.field.value.trim(), provider: protocol.value as DiagramProvider })
      if (d.dialog.isConnected) d.status.textContent = '连接成功，已收到演示图表。若要用于文档，请保存设置。'
    })
  })
}
