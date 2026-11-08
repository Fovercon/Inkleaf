/** Only public settings and task text cross the preload bridge. Secrets never return. */
export type ModelAction = 'explain' | 'translate' | 'summarize' | 'chat'
export interface ModelMessage { role: 'user' | 'assistant'; content: string }
export type DiagramProvider = 'plantuml' | 'kroki'
export interface ServiceSettings {
  plantumlUrl: string
  diagramProvider?: DiagramProvider
  provider: 'compatible' | 'ollama'
  endpoint: string
  model: string
  hasKey: boolean
  keyStorage: 'encrypted' | 'session' | 'none'
  secureStorage: boolean
}
export interface ServiceSettingsInput {
  /** Scope prevents an open dialog overwriting unrelated settings saved elsewhere. */
  scope?: 'diagram' | 'model'
  plantumlUrl: string
  diagramProvider?: DiagramProvider
  provider: 'compatible' | 'ollama'
  endpoint: string
  model: string
  key?: string
  clearKey?: boolean
  rememberKey?: boolean
}
export interface ModelRequest { id: string; action: ModelAction; text: string; language?: string; question?: string; history?: ModelMessage[] }
export interface ModelChunk { id: string; text: string }
