import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

function entryInfo(filename: string) {
  return fs.lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error })
}

async function privateDirectory(directory: string): Promise<boolean> {
  const info = await entryInfo(directory)
  return !!info && info.isDirectory() && info.uid === process.getuid?.() &&
    (info.mode & 0o777) === 0o700 && await fs.realpath(directory) === directory
}

async function readUpdateFile(filename: string): Promise<string> {
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || info.size > 16384) throw new Error('Invalid update metadata')
    return await file.readFile('utf8')
  } finally { await file.close() }
}

async function removeOwnedEntry(filename: string, directory = false): Promise<void> {
  const info = await entryInfo(filename)
  if (info && info.uid === process.getuid?.() && (directory ? info.isDirectory() : info.isFile())) {
    await fs.rm(filename, { recursive: directory, force: true })
  }
}

async function removeDownload(cache: string, downloaded: unknown, appImage: boolean): Promise<void> {
  if (typeof downloaded !== 'string' || path.basename(downloaded) !== (appImage ? 'update.AppImage' : 'update.zip')) return
  const directory = path.dirname(downloaded)
  if (path.dirname(directory) !== cache || !/^download-[A-Za-z0-9]{6}$/.test(path.basename(directory))) return
  if (await fs.realpath(cache) === cache && await privateDirectory(directory)) {
    await removeOwnedEntry(path.join(directory, path.basename(downloaded)))
    // Leave the directory in place if it contains anything else.
    await fs.rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error })
  }
}

export async function finishUpdateStartup(cache: string, target: string, version: string, appImage: boolean, launchNonce?: string): Promise<void> {
  if (await fs.realpath(target) !== target) return
  const ticket = JSON.parse(await readUpdateFile(path.join(cache, 'transaction.json')))
  if (ticket.version !== version || ticket.target !== target || typeof ticket.nonce !== 'string' ||
    !/^[a-f0-9]{48}$/.test(ticket.nonce) || (launchNonce !== undefined && launchNonce !== ticket.nonce)) return
  const job = ticket.job
  if (typeof job !== 'string' || path.dirname(job) !== path.dirname(target) ||
    !/^\.inkleaf-update-[A-Za-z0-9]{6}$/.test(path.basename(job)) || !await privateDirectory(job)) return
  const ack = path.join(job, 'boot-ack'), result = path.join(job, 'result.json')
  if (ticket.ack !== ack || ticket.result !== result) return

  if (launchNonce !== undefined) {
    await fs.writeFile(ack, launchNonce, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  }
  if (await readUpdateFile(ack) !== ticket.nonce) return
  const backup = path.join(job, appImage ? 'previous.AppImage' : 'Inkleaf.app')
  // The native helper writes its final receipt after seeing the renderer's ACK.
  // A later ordinary launch can retry cleanup using that same receipt and ACK.
  const deadline = Date.now() + (launchNonce === undefined ? 0 : 10000)
  while (true) {
    const receipt = JSON.parse(await readUpdateFile(result))
    if (receipt.version !== version || receipt.backupPath !== backup) return
    if (receipt.state === 'installed') {
      await removeOwnedEntry(backup, !appImage)
      await removeOwnedEntry(path.join(job, 'install-helper'))
      await removeDownload(cache, ticket.downloaded, appImage)
      return
    }
    if (receipt.state !== 'restarting' || Date.now() >= deadline) return
    await delay(100)
  }
}
