import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Desktop launchers can pass a filename or a file:// URL after the executable. */
export function markdownFromArguments(args: string[], workingDirectory: string): string | null {
  let positionalOnly = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { positionalOnly = true; continue }
    if (!positionalOnly && arg === '--inkleaf-update') { i++; continue }
    if (!positionalOnly && arg.startsWith('-')) continue
    try {
      const filename = arg.startsWith('file:') ? fileURLToPath(arg) : path.resolve(workingDirectory, arg)
      if (!/\.(md|markdown)$/i.test(filename) || !fs.statSync(filename).isFile()) continue
      return filename
    } catch { /* Ignore flags, missing files and non-local URLs from launchers. */ }
  }
  return null
}
