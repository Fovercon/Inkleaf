import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ImageResolution } from '../shared/ipc'

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
}
interface Root { path: string; real: Promise<string> }
const rootFor = (directory: string): Root => ({ path: path.resolve(directory), real: fs.realpath(directory).catch(() => '') })
function within(root: string, filename: string): boolean {
  const relative = path.relative(root, filename)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
function failure(error: NonNullable<ImageResolution['error']>, filename?: string): ImageResolution {
  const message = {
    'not-found': '图片文件不存在，请检查路径和文件名大小写。',
    forbidden: '图片不在书库或文档文件夹内，请将图片放入这些文件夹。',
    unreadable: '无法读取图片，请检查文件的读取权限。',
    invalid: '图片路径或文件类型不受支持。',
  }[error]
  return { error, message, ...(filename ? { path: filename } : {}) }
}
const filesystemError = (error: unknown, filename: string) => failure(
  ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '') ? 'not-found' : 'unreadable', filename,
)
function decode(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}
function referencePath(source: string, documentPath: string, preserveSuffix = false): string | null {
  if (!source || source.length > 32768 || source.includes('\0')) return null
  try {
    if (/^file:/i.test(source)) return path.resolve(fileURLToPath(new URL(source)))
    if (/^mdasset:/i.test(source)) return protocolPath(source)
    if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return null
    // An existing literal filename wins; otherwise honor URL query/fragment suffixes.
    // Decode last so encoded # and ? always stay part of the filename.
    const filename = decode(preserveSuffix ? source : source.split(/[?#]/, 1)[0])
    if (!filename || filename.includes('\0')) return null
    return path.resolve(path.dirname(documentPath), filename)
  } catch { return null }
}
function protocolPath(source: string): string | null {
  try {
    const url = new URL(source)
    if (url.protocol !== 'mdasset:' || url.host !== 'local' || url.username || url.password) return null
    const filename = decodeURIComponent(url.pathname)
    return filename.includes('\0') || !path.isAbsolute(filename) ? null : path.resolve(filename)
  } catch { return null }
}

/** Only the selected library and parents of successfully read Markdown files grant image access. */
export class TrustedLocalAssets {
  private library: Root | null = null
  private documents = new Map<string, Root>()
  private generation = 0
  get epoch(): number { return this.generation }

  setLibraryRoot(directory: string | null): void {
    this.generation++
    this.library = directory ? rootFor(directory) : null
    this.documents.clear()
  }

  async registerDocument(documentPath: string, epoch = this.epoch): Promise<void> {
    if (typeof documentPath !== 'string' || !path.isAbsolute(documentPath) || !/\.(md|markdown|mdx)$/i.test(documentPath)) return
    try {
      if (!(await fs.stat(documentPath)).isFile()) return
      const root = rootFor(path.dirname(documentPath))
      if (!await root.real || epoch !== this.epoch) return
      this.documents.set(path.resolve(documentPath), root)
    } catch { /* A failed or cancelled read cannot authorize a new directory. */ }
  }

  private async inspect(filename: string, roots: Root[]): Promise<ImageResolution & { realFile?: string }> {
    const candidates = roots.filter(root => within(root.path, filename))
    if (!candidates.length) return failure('forbidden', filename)
    try {
      const realFile = await fs.realpath(filename)
      const realRoots = await Promise.all(candidates.map(root => root.real))
      if (!realRoots.some(root => root && within(root, realFile))) return failure('forbidden', filename)
      if (!(await fs.stat(realFile)).isFile() || !MIME[path.extname(filename).toLowerCase()]) return failure('invalid', filename)
      await fs.access(realFile, constants.R_OK)
      return { path: filename, url: 'mdasset://local' + pathToFileURL(filename).pathname, realFile }
    } catch (error) { return filesystemError(error, filename) }
  }

  async resolveImage(source: string, documentPath: string): Promise<ImageResolution> {
    if (typeof source !== 'string' || typeof documentPath !== 'string' || !path.isAbsolute(documentPath)) return failure('invalid')
    const document = this.documents.get(path.resolve(documentPath))
    const filenames = [...new Set([referencePath(source, documentPath, true), referencePath(source, documentPath)].filter((value): value is string => !!value))]
    if (!filenames.length) return failure('invalid')
    if (!document) return failure('forbidden', filenames[0])
    const epoch = this.epoch
    const roots = [...(this.library ? [this.library] : []), document]
    let result: ImageResolution & { realFile?: string } = failure('invalid')
    for (const filename of filenames) {
      result = await this.inspect(filename, roots)
      if (!result.error) break
    }
    const { realFile: _realFile, ...resolution } = result
    return epoch === this.epoch ? resolution : failure('forbidden', result.path)
  }

  async response(requestUrl: string): Promise<Response> {
    const filename = protocolPath(requestUrl)
    if (!filename) return new Response('invalid image path', { status: 400 })
    const epoch = this.epoch
    const roots = [...(this.library ? [this.library] : []), ...this.documents.values()]
    const result = await this.inspect(filename, roots)
    if (epoch !== this.epoch) return new Response('forbidden', { status: 403 })
    if (result.error) return new Response(result.message, { status: {
      'not-found': 404, forbidden: 403, unreadable: 500, invalid: 400,
    }[result.error] })
    try {
      const bytes = await fs.readFile(result.realFile!)
      if (epoch !== this.epoch) return new Response('forbidden', { status: 403 })
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': MIME[path.extname(filename).toLowerCase()] } })
    } catch (error) {
      const failed = filesystemError(error, filename)
      return new Response(failed.message, { status: failed.error === 'not-found' ? 404 : 500 })
    }
  }
}

export const localAssets = new TrustedLocalAssets()
export const handleLocalAsset = (requestUrl: string, access = localAssets) => access.response(requestUrl)
