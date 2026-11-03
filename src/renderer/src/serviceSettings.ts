import { element, input, toolDialog } from './toolDialog'

export function openServiceSettings(section: 'diagram' | 'model' = 'model', changed?: () => void) {
  const d = toolDialog(section === 'diagram' ? '图表服务设置' : '模型连接设置')
  void d.run(async () => {
    const settings = await window.mdr.serviceSettings()
    if (!d.dialog.isConnected) return
    const plantuml = input('PlantUML 服务根地址', settings.plantumlUrl)
    plantuml.field.placeholder = 'http://localhost:8080 或 https://你的服务/plantuml'
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
      d.body.append(element('p', 'Graphviz 离线可用，无需设置。PlantUML 需要本机或自建服务；保存后，打开文档时会把 PlantUML 代码发送到此地址。请仅配置你信任的服务。', 'tool-hint'), plantuml.wrap)
    } else {
      d.body.append(element('p', '只在你主动点击“发送选文”时请求模型。不会发送文档路径或整座书库。兼容服务根地址通常以 /v1 结尾；Ollama 使用服务根地址。', 'tool-hint'), providerLabel, endpoint.wrap, model.wrap, key.wrap, remember.wrap, clear.wrap)
      d.body.append(element('p', settings.hasKey ? `已有 Key：${settings.keyStorage === 'encrypted' ? '系统加密保存' : '仅本次会话有效'}。` : '尚未设置 Key。本机 Ollama 通常不需要 Key。', 'tool-hint'))
      if (!settings.secureStorage) d.body.append(element('p', '系统加密存储不可用，Key 仅在本次运行中保留，退出后需重新输入。', 'tool-hint'))
    }
    provider.onchange = () => {
      endpoint.field.value = provider.value === 'ollama' ? 'http://localhost:11434' : ''
      key.field.value = ''; model.field.value = ''
    }
    d.button('保存设置', async () => {
      const next = await window.mdr.saveServiceSettings({ plantumlUrl: plantuml.field.value.trim(), provider: provider.value as 'compatible' | 'ollama', endpoint: endpoint.field.value.trim(), model: model.field.value.trim(), key: key.field.value || undefined, clearKey: clear.field.checked, rememberKey: remember.field.checked })
      key.field.value = ''; d.status.classList.remove('error')
      d.status.textContent = section === 'diagram' ? '已保存，重新渲染当前文档。' : `已保存连接。${next.hasKey && next.keyStorage === 'session' ? 'Key 仅在本次会话有效。' : ''}请回到选文助手发送请求。`
      changed?.()
    })
  })
}
