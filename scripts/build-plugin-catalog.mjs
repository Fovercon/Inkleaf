// Rebuild the official flat JSON directory from readable, reviewed plugin packages.
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
const destination = new URL('../resources/plugin-catalog.json', import.meta.url)
const catalog = JSON.parse(await readFile(destination, 'utf8'))
const packages = new URL('../resources/plugins/', import.meta.url)
const entries = catalog.entries.filter(p => p.bundled)
for (const folder of (await readdir(packages)).sort()) {
  const root = new URL(folder + '/', packages)
  const files = {}, hashes = {}
  for (const name of (await readdir(root)).sort()) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.(json|mjs|js)$/.test(name)) throw Error('Unsupported catalog file ' + name)
    files[name] = await readFile(new URL(name, root), 'utf8')
    hashes[name] = createHash('sha256').update(files[name]).digest('hex')
  }
  const manifest = JSON.parse(files['ink.plugin.json'])
  if (manifest.id !== folder || path.basename(folder) !== folder) throw Error('Plugin ID must match folder')
  entries.push({ ...manifest, files, hashes })
}
await writeFile(destination, JSON.stringify({ schema: 1, entries }, null, 2) + '\n')
console.log(`Built official directory: ${entries.length} plugins`)
