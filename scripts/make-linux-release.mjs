// Native Linux build: helper, Electron, and installer architecture must agree.
import { createReadStream } from 'node:fs'
import { access, open, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
let arch = process.arch
let skipBuild = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--arch' && ['arm64', 'x64'].includes(args[i + 1])) arch = args[++i]
  else if (args[i] === '--skip-build') skipBuild = true
  else throw new Error('Usage: node scripts/make-linux-release.mjs [--arch arm64|x64] [--skip-build]')
}
if (process.platform !== 'linux') throw new Error('Linux releases must be built and verified on Linux')
if (!['x64', 'arm64'].includes(arch) || arch !== process.arch) throw new Error('Use a native x64 or arm64 Linux runner so the update helper and smoke tests match the package')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Release version must be stable x.y.z')
if (pkg.build?.appId !== 'com.fovercon.inkleaf' || pkg.build?.linux?.executableName !== 'inkleaf') throw new Error('Unexpected Linux application identity')
if (!skipBuild) {
  execFileSync(process.execPath, ['esbuild.mjs'], { cwd: root, stdio: 'inherit' })
  // electron-builder maps x64 to x86_64/amd64 in ${arch}; the updater uses x64.
  const artifactPattern = `Inkleaf-${pkg.version}-linux-${arch}.` + '${ext}'
  execFileSync(process.execPath, ['node_modules/electron-builder/cli.js', '--linux', 'AppImage', 'deb', `--${arch}`, `-c.linux.artifactName=${artifactPattern}`, '--publish', 'never'], { cwd: root, stdio: 'inherit' })
}
const output = path.join(root, 'dist')
const unpacked = path.join(output, arch === 'x64' ? 'linux-unpacked' : 'linux-arm64-unpacked')
const bundled = JSON.parse(await readFile(path.join(unpacked, 'resources', 'app', 'package.json'), 'utf8'))
if (bundled.version !== pkg.version || bundled.name !== 'inkleaf') throw new Error('Linux packaged version or identity does not match')
const helper = path.join(unpacked, 'resources', 'app', 'out', 'inkleaf-update-helper')
await access(helper)
const readElf = async filename => {
  const file = await open(filename, 'r')
  const data = Buffer.alloc(64)
  try {
    const { bytesRead } = await file.read(data, 0, data.length, 0)
    if (bytesRead !== data.length) throw new Error(`ELF header is incomplete: ${filename}`)
  } finally { await file.close() }
  const machine = arch === 'x64' ? 62 : 183
  if (data.subarray(0, 4).toString('hex') !== '7f454c46' || data[4] !== 2 || data[5] !== 1 || data.readUInt16LE(18) !== machine) throw new Error(`ELF architecture mismatch: ${filename}`)
  return data
}
await readElf(helper)
console.log('Native update helper GNU libc symbol requirements:')
execFileSync('readelf', ['--wide', '--version-info', helper], { stdio: 'inherit' })
const image = path.join(output, `Inkleaf-${pkg.version}-linux-${arch}.AppImage`)
const elf = await readElf(image)
if (elf.subarray(8, 11).toString('hex') !== '414902') throw new Error('Expected a type 2 AppImage')
const deb = path.join(output, `Inkleaf-${pkg.version}-linux-${arch}.deb`)
const fields = execFileSync('dpkg-deb', ['--field', deb, 'Package', 'Version', 'Architecture'], { encoding: 'utf8' })
const debArch = arch === 'x64' ? 'amd64' : 'arm64'
if (!fields.includes('Package: inkleaf\n') || !fields.includes(`Version: ${pkg.version}\n`) || !fields.includes(`Architecture: ${debArch}\n`)) throw new Error(`Unexpected Debian package metadata: ${fields}`)
for (const filename of [image, deb]) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  await writeFile(`${filename}.sha256`, `${hash.digest('hex')}  ${path.basename(filename)}\n`, 'utf8')
}
console.log(`Linux ${arch} AppImage, deb, and SHA-256 assets written to dist/`)
