import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

/** Validate the AppImage runtime without executing downloaded code. */
export function validateAppImageHeader(header: Uint8Array, arch: string): void {
  const data = Buffer.from(header)
  const machine = arch === 'x64' ? 62 : arch === 'arm64' ? 183 : 0
  if (!machine || data.length < 64 || data.readUInt32BE(0) !== 0x7f454c46 ||
    data[4] !== 2 || data[5] !== 1 || data[6] !== 1 ||
    !data.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02])) ||
    ![2, 3].includes(data.readUInt16LE(16)) || data.readUInt16LE(18) !== machine ||
    data.readUInt16LE(52) !== 64) throw new Error('更新包不是适合此处理器的 AppImage')
}

export async function validateAppImageFile(filename: string, arch: string, executable = false): Promise<void> {
  if (!path.isAbsolute(filename) || await fs.realpath(filename) !== filename) throw new Error('AppImage 路径不能包含符号链接')
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 64 || info.nlink !== 1) throw new Error('AppImage 必须是独立的常规文件')
    const header = Buffer.alloc(64), { bytesRead } = await file.read(header, 0, header.length, 0)
    if (bytesRead !== header.length) throw new Error('AppImage 文件不完整')
    validateAppImageHeader(header, arch)
  } finally { await file.close() }
  if (executable) await fs.access(filename, constants.X_OK)
}

export async function appImageTarget(filename: string | undefined, arch: string): Promise<string> {
  if (!filename || !path.isAbsolute(filename) || !/^Inkleaf[^/]*\.AppImage$/.test(path.basename(filename))) throw new Error('请从可写目录中的 Inkleaf AppImage 启动应用再更新')
  await validateAppImageFile(filename, arch, true)
  const parent = path.dirname(filename), info = await fs.lstat(filename)
  if (await fs.realpath(parent) !== parent || info.uid !== process.getuid?.()) throw new Error('AppImage 安装路径或文件所有者不支持自动更新')
  await fs.access(filename, constants.W_OK)
  await fs.access(parent, constants.W_OK | constants.X_OK)
  return filename
}
