import path from 'node:path'

export const REPOSITORY = 'Fovercon/Inkleaf'
export const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`
export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
export interface UpdateCandidate {
  version: string
  url: string
  sha256: string
  size: number
  notes: string
  releaseUrl: string
}

export function versionParts(version: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('版本号格式不正确')
  const parts = version.split('.').map(Number)
  if (parts.some(p => !Number.isSafeInteger(p))) throw new Error('版本号超出范围')
  return parts
}
export function isNewer(version: string, current: string): boolean {
  const a = versionParts(version), b = versionParts(current)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}
export function selectRelease(value: unknown, current: string, arch: string): UpdateCandidate | null {
  if (arch !== 'arm64') throw new Error('当前发布仅支持 Apple Silicon Mac')
  const release = value as Record<string, unknown> | null
  if (!release || typeof release !== 'object' || release.draft !== false || release.prerelease !== false) throw new Error('发布信息无效')
  if (typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) throw new Error('发布标签无效')
  const version = release.tag_name.slice(1)
  versionParts(version)
  if (!isNewer(version, current)) return null
  const assetName = `Inkleaf-${version}-mac-${arch}.zip`
  if (!Array.isArray(release.assets)) throw new Error('发布缺少更新包')
  const matching = release.assets.filter(a => a?.name === assetName)
  if (matching.length !== 1) throw new Error('这个版本尚未提供适合此 Mac 的更新包')
  const asset = matching[0]
  if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE_BYTES) throw new Error('更新包大小无效')
  if (typeof asset.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest)) throw new Error('更新包缺少可信的完整性校验，暂时无法安装')
  const expected = `https://github.com/${REPOSITORY}/releases/download/v${version}/${assetName}`
  if (asset.browser_download_url !== expected) throw new Error('更新包地址不属于本项目')
  return { version, url: expected, sha256: asset.digest.slice(7).toLowerCase(), size: asset.size,
    notes: typeof release.body === 'string' ? release.body.slice(0, 16000) : '',
    releaseUrl: `https://github.com/${REPOSITORY}/releases/tag/v${version}` }
}

export function validateEntryName(name: string): string {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.')) throw new Error('更新包含有不安全的路径')
  const clean = name.replace(/\/$/, '')
  if (clean.split('/').some(p => !p)) throw new Error('更新包含有不规范的路径')
  if (clean !== 'Inkleaf.app' && !clean.startsWith('Inkleaf.app/')) throw new Error('更新包只能包含 Inkleaf.app')
  return clean
}
export function validateLink(name: string, target: string): void {
  if (!target || target.includes('\0') || target.includes('\\') || path.posix.isAbsolute(target)) throw new Error('更新包含有不安全的符号链接')
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target))
  if (resolved !== 'Inkleaf.app' && !resolved.startsWith('Inkleaf.app/')) throw new Error('更新包符号链接超出应用目录')
}
export function validateDownloadHost(url: string, api = false): void {
  const u = new URL(url)
  const allowed = api ? ['api.github.com'] : ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !allowed.includes(u.hostname)) throw new Error('更新请求地址不受信任')
}
