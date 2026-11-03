/** Only public settings and task text cross the preload bridge. Secrets never return. */
export type ModelAction = 'explain' | 'translate' | 'summarize'
export interface ServiceSettings {
  plantumlUrl: string
  provider: 'compatible' | 'ollama'
  endpoint: string
  model: string
  hasKey: boolean
  keyStorage: 'encrypted' | 'session' | 'none'
  secureStorage: boolean
}
export interface ServiceSettingsInput {
  plantumlUrl: string
  provider: 'compatible' | 'ollama'
  endpoint: string
  model: string
  key?: string
  clearKey?: boolean
  rememberKey?: boolean
}
export interface ModelRequest { id: string; action: ModelAction; text: string; language?: string }
export interface ModelChunk { id: string; text: string }
