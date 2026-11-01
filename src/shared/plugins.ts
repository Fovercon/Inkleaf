/** Public catalog metadata; executable payloads never cross the renderer bridge. */
export interface PluginDetails {
  description?: string
  author?: string
  category?: string
  usage?: string
  examples?: { title: string; markdown: string }[]
  changelog?: { version: string; notes: string }[]
  minAppVersion?: string
}
export interface CatalogEntry extends PluginDetails {
  id: string
  name: string
  version: string
  bundled?: boolean
  permissions: string[]
}
export interface CatalogState {
  entries: CatalogEntry[]
  source: 'bundled' | 'cache' | 'online'
  checkedAt?: string
  warning?: string
}
export interface PluginResult { ok: boolean; canceled?: boolean; error?: string; id?: string }
// Stable releases only: no ambiguous prerelease ordering or lossy numeric coercion.
export function parsePluginVersion(value: unknown): number[] | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null
  const parts = value.split('.').map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}
export function comparePluginVersions(a: string, b: string): number | null {
  const left = parsePluginVersion(a), right = parsePluginVersion(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  return 0
}
