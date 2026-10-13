// Build the self-update assets without uploading or publishing anything.
// The .app stays in dist/mac-arm64 (or dist/mac for an explicit x64 build).
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
let arch = 'arm64'
let skipBuild = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--arch' && ['arm64', 'x64'].includes(args[i + 1])) arch = args[++i]
  else if (args[i] === '--skip-build') skipBuild = true
  else throw new Error('Usage: node scripts/make-release.mjs [--arch arm64|x64] [--skip-build]')
}
if (process.platform !== 'darwin') throw new Error('Release bundles must be built on macOS')

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Release version must be a stable x.y.z version')
if (pkg.build?.productName !== 'Inkleaf' || pkg.build?.appId !== 'com.fovercon.inkleaf') {
  throw new Error('Release identity must match the installed Inkleaf application')
}

if (!skipBuild) {
  execFileSync(process.execPath, ['scripts/make-icon.mjs'], { cwd: root, stdio: 'inherit' })
  execFileSync(process.execPath, ['esbuild.mjs'], { cwd: root, stdio: 'inherit' })
  execFileSync(process.execPath, [
    'node_modules/electron-builder/cli.js', '--mac', 'dir', `--${arch}`, '--publish', 'never'
  ], { cwd: root, stdio: 'inherit' })
}

const output = path.join(root, 'dist')
const app = path.join(output, arch === 'arm64' ? 'mac-arm64' : 'mac', 'Inkleaf.app')
const plist = path.join(app, 'Contents', 'Info.plist')
const plistValue = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim()
if (plistValue('CFBundleShortVersionString') !== pkg.version) throw new Error('Packaged version does not match package.json')
if (plistValue('CFBundleIdentifier') !== pkg.build.appId) throw new Error('Packaged application identity does not match')
const executable = plistValue('CFBundleExecutable')
if (!/^[\w .-]+$/.test(executable)) throw new Error('Invalid bundle executable name')
const bundledArch = execFileSync('/usr/bin/lipo', ['-archs', path.join(app, 'Contents', 'MacOS', executable)], { encoding: 'utf8' }).trim()
const machoArch = arch === 'x64' ? 'x86_64' : arch
if (bundledArch !== machoArch) throw new Error(`Expected ${arch} application, found ${bundledArch}`)

const filename = `Inkleaf-${pkg.version}-mac-${arch}.zip`
const archive = path.join(output, filename)
await mkdir(output, { recursive: true })
await rm(archive, { force: true })
// keepParent makes Inkleaf.app the ZIP root and preserves bundle symlinks.
execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, archive], { stdio: 'inherit' })
const hash = createHash('sha256')
for await (const chunk of createReadStream(archive)) hash.update(chunk)
await writeFile(`${archive}.sha256`, `${hash.digest('hex')}  ${filename}\n`, 'utf8')
console.log(`Release assets written to dist/${filename} and dist/${filename}.sha256`)
