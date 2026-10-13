// Build all macOS icon sizes from the committed Inkleaf artwork.
// Requires sips and iconutil (included with macOS); no extra dependencies.
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = path.join(root, 'build')
const source = path.join(buildDir, 'inkleaf-icon.png')
const base = path.join(buildDir, 'icon-base.png')
const iconset = path.join(buildDir, 'icon.iconset')
const output = path.join(buildDir, 'icon.icns')

if (process.platform !== 'darwin') throw new Error('macOS is required to build the .icns file')
if (!existsSync(source)) throw new Error(`Missing icon artwork: ${source}`)
const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', source], { encoding: 'utf8' })
const width = Number(info.match(/pixelWidth:\s*(\d+)/)?.[1])
const height = Number(info.match(/pixelHeight:\s*(\d+)/)?.[1])
if (width !== height || width < 1024) throw new Error('Icon artwork must be square and at least 1024 × 1024')

mkdirSync(buildDir, { recursive: true })
execFileSync('sips', ['-z', '1024', '1024', source, '--out', base], { stdio: 'ignore' })
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const pixels = String(size * scale)
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
    execFileSync('sips', ['-z', pixels, pixels, base, '--out', path.join(iconset, name)], { stdio: 'ignore' })
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', output])
console.log('Inkleaf icon written to build/icon.icns')
