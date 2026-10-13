import * as yauzl from 'yauzl'
import { validateEntryName, validateLink } from './updatePolicy'

/** Preflight before ditto: allow legitimate framework links, never write through them. */
export function validateArchive(filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('更新包无法读取'))
      const entries = new Map<string, number>()
      let expanded = 0, actualExpanded = 0, count = 0, done = false
      const fail = (e: Error) => { if (done) return; done = true; zip.close(); reject(e) }
      zip.on('error', fail)
      zip.on('end', () => {
        if (done) return
        for (const name of entries.keys()) {
          const parts = name.split('/')
          let parent = parts[0]
          for (let i = 1; i < parts.length; i++) {
            const kind = entries.get(parent)
            if (kind && kind !== 0x4000) return fail(new Error(kind === 0xa000 ? '更新包试图写入符号链接目录' : '更新包包含文件与目录路径冲突'))
            parent += '/' + parts[i]
          }
        }
        if (!entries.has('inkleaf.app/contents/info.plist') || !entries.has('inkleaf.app/contents/macos/inkleaf')) return fail(new Error('更新包缺少应用文件'))
        done = true; resolve()
      })
      zip.on('entry', (entry: yauzl.Entry) => {
        try {
          const rawName = validateEntryName(entry.fileName)
          // Most Mac installations use case-insensitive, Unicode-normalizing APFS.
          const name = rawName.normalize('NFC').toLowerCase()
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff
          const kind = (mode & 0xf000) || (entry.fileName.endsWith('/') ? 0x4000 : 0x8000)
          if (kind && ![0x8000, 0x4000, 0xa000].includes(kind)) throw new Error('更新包包含特殊文件')
          if (entries.has(name)) throw new Error('更新包包含重复路径')
          entries.set(name, kind)
          expanded += entry.uncompressedSize
          if (++count > 50000 || expanded > 3 * 1024 ** 3) throw new Error('更新包解压大小超出限制')
          if (entry.generalPurposeBitFlag & 1) throw new Error('更新包不能是加密归档')
          if (kind === 0x4000) {
            if (entry.uncompressedSize !== 0) throw new Error('更新包目录不能包含文件数据')
            return zip.readEntry()
          }
          if (kind === 0xa000 && entry.uncompressedSize > 4096) throw new Error('更新包符号链接无效')
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) return fail(err ?? new Error('符号链接无法读取'))
            const chunks: Buffer[] = []
            let bytes = 0
            stream.on('error', fail)
            stream.on('data', chunk => {
              bytes += chunk.length; actualExpanded += chunk.length
              if (bytes > entry.uncompressedSize || actualExpanded > 3 * 1024 ** 3) {
                stream.destroy(); return fail(new Error('更新包实际解压大小与声明不一致'))
              }
              if (kind === 0xa000) chunks.push(Buffer.from(chunk))
            })
            stream.on('end', () => {
              if (done) return
              try {
                if (kind === 0xa000) validateLink(rawName, Buffer.concat(chunks).toString('utf8'))
                zip.readEntry()
              }
              catch (e) { fail(e as Error) }
            })
          })
        } catch (e) { fail(e as Error) }
      })
      zip.readEntry()
    })
  })
}
