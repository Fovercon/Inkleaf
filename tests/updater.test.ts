import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { selectRelease, selectManualRelease, validateDownloadHost, MAX_ARCHIVE_BYTES } from '../src/main/updatePolicy'
import { validateArchive } from '../src/main/updateArchive'
import { appImageTarget, validateAppImageFile, validateAppImageHeader } from '../src/main/linuxAppImage'

const digest = 'a1'.repeat(32)
const version = '0.3.0'
function release(overrides: Record<string, unknown> = {}, assetOverrides: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    body: 'New release notes',
    assets: [{
      name: `Inkleaf-${version}-mac-arm64.zip`,
      state: 'uploaded',
      size: 2048,
      digest: `sha256:${digest}`,
      browser_download_url: `https://github.com/Fovercon/Inkleaf/releases/download/v${version}/Inkleaf-${version}-mac-arm64.zip`,
      ...assetOverrides
    }],
    ...overrides
  }
}

test('selectRelease selects only a newer stable release and preserves trusted metadata', () => {
  const candidate = selectRelease(release(), '0.2.0', 'arm64')
  assert.ok(candidate)
  assert.equal(candidate.version, '0.3.0')
  assert.equal(candidate.sha256, digest)
  assert.equal(candidate.size, 2048)
  assert.equal(candidate.notes, 'New release notes')
  assert.equal(candidate.releaseUrl, 'https://github.com/Fovercon/Inkleaf/releases/tag/v0.3.0')
  assert.equal(selectRelease(release(), '0.3.0', 'arm64'), null)
  assert.equal(selectRelease(release(), '1.0.0', 'arm64'), null)
  // Old releases need no downloadable asset, and version comparison is numeric.
  assert.equal(selectRelease(release({ assets: [] }), '0.10.0', 'arm64'), null)
  assert.ok(selectRelease(release(), '0.0.10', 'arm64'))
})

test('selectRelease rejects draft, prerelease and invalid version metadata', () => {
  for (const invalid of [null, {}, release({ draft: true }), release({ prerelease: true }), release({ draft: undefined })]) {
    assert.throws(() => selectRelease(invalid, '0.2.0', 'arm64'))
  }
  for (const tag of ['0.3.0', 'v0.3.0-beta.1', 'v01.3.0', 'v0.3', 'v9007199254740992.0.0']) {
    assert.throws(() => selectRelease(release({ tag_name: tag }), '0.2.0', 'arm64'))
  }
  assert.throws(() => selectRelease(release(), '0.2.0-beta.1', 'arm64'))
})

test('selectRelease requires a single complete asset and GitHub-provided SHA-256', () => {
  for (const invalid of [undefined, null, '', `sha256:${'a'.repeat(63)}`, `sha1:${'a'.repeat(40)}`]) {
    assert.throws(() => selectRelease(release({}, { digest: invalid }), '0.2.0', 'arm64'))
  }
  assert.equal(selectRelease(release({}, { digest: `SHA256:${digest.toUpperCase()}` }), '0.2.0', 'arm64')?.sha256, digest)
  assert.throws(() => selectRelease(release({}, { state: 'new' }), '0.2.0', 'arm64'))
  assert.throws(() => selectRelease(release({ assets: [] }), '0.2.0', 'arm64'))
  const duplicate = release()
  duplicate.assets.push({ ...duplicate.assets[0] })
  assert.throws(() => selectRelease(duplicate, '0.2.0', 'arm64'))
})

test('selectRelease rejects unusable asset sizes', () => {
  for (const size of [0, -1, 1.5, MAX_ARCHIVE_BYTES + 1, Number.MAX_SAFE_INTEGER + 1, '2048', null]) {
    assert.throws(() => selectRelease(release({}, { size }), '0.2.0', 'arm64'))
  }
  assert.equal(selectRelease(release({}, { size: MAX_ARCHIVE_BYTES }), '0.2.0', 'arm64')?.size, MAX_ARCHIVE_BYTES)
})

test('selectRelease binds the update to this repository, version and architecture', () => {
  const url = release().assets[0].browser_download_url
  for (const invalid of [
    url.replace('Fovercon/Inkleaf', 'OtherOwner/Inkleaf'),
    url.replace('github.com/', 'github.com.evil.example/'),
    url.replace('https:', 'http:'),
    url.replace('/v0.3.0/', '/v0.4.0/'),
    url.replace('-arm64.zip', '-x64.zip'),
    `${url}?download=1`
  ]) {
    assert.throws(() => selectRelease(release({}, { browser_download_url: invalid }), '0.2.0', 'arm64'))
  }
  assert.throws(() => selectRelease(release({}, { name: 'Inkleaf-0.3.0-mac-x64.zip' }), '0.2.0', 'arm64'))
  for (const arch of ['x64', 'ia32', '', 'arm64/../../other']) {
    assert.throws(() => selectRelease(release(), '0.2.0', arch))
  }
})

test('Linux selects only the matching native AppImage with its GitHub digest', () => {
  for (const arch of ['x64', 'arm64']) {
    const name = `Inkleaf-${version}-linux-${arch}.AppImage`
    const value = release({}, { name, browser_download_url: `https://github.com/Fovercon/Inkleaf/releases/download/v${version}/${name}` })
    assert.equal(selectRelease(value, '0.2.2', arch, 'linux')?.sha256, digest)
    assert.equal(selectRelease(value, '0.3.0', arch, 'linux'), null)
    assert.throws(() => selectRelease(value, '0.2.2', arch === 'x64' ? 'arm64' : 'x64', 'linux'))
    assert.throws(() => selectRelease({ ...value, assets: [{ ...value.assets[0], name: name.replace('.AppImage', '.deb') }] }, '0.2.2', arch, 'linux'))
    assert.throws(() => selectRelease({ ...value, assets: [{ ...value.assets[0], digest: undefined }] }, '0.2.2', arch, 'linux'))
    assert.throws(() => selectRelease({ ...value, assets: [{ ...value.assets[0], browser_download_url: value.assets[0].browser_download_url.replace('Fovercon', 'Other') }] }, '0.2.2', arch, 'linux'))
  }
  assert.throws(() => selectRelease(release(), '0.2.2', 'ia32', 'linux'))
  assert.throws(() => selectRelease(release(), '0.2.2', 'x64', 'win32'))
})

test('package-managed Linux installs announce official stable versions without enabling a download', () => {
  const summary = selectManualRelease(release({ assets: [] }), '0.2.2')
  assert.ok(summary)
  assert.equal(summary.releaseUrl, 'https://github.com/Fovercon/Inkleaf/releases/tag/v0.3.0')
  assert.equal('url' in summary, false)
  assert.equal(selectManualRelease(release(), '0.3.0'), null)
  assert.throws(() => selectManualRelease(release({ prerelease: true }), '0.2.2'))
})

function appImageHeader(arch: string): Buffer {
  const header = Buffer.alloc(64)
  header.writeUInt32BE(0x7f454c46, 0)
  header[4] = 2; header[5] = 1; header[6] = 1
  header.set([0x41, 0x49, 0x02], 8)
  header.writeUInt16LE(2, 16)
  header.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18)
  header.writeUInt16LE(64, 52)
  return header
}

test('AppImage inspection rejects invalid runtimes and another processor before execution', () => {
  for (const arch of ['x64', 'arm64']) {
    assert.doesNotThrow(() => validateAppImageHeader(appImageHeader(arch), arch))
    assert.throws(() => validateAppImageHeader(appImageHeader(arch), arch === 'x64' ? 'arm64' : 'x64'))
    for (const offset of [0, 4, 5, 6, 8, 9, 10, 16, 18, 52]) {
      const header = appImageHeader(arch); header[offset] = 0
      assert.throws(() => validateAppImageHeader(header, arch))
    }
  }
  assert.throws(() => validateAppImageHeader(Buffer.alloc(10), 'x64'))
  assert.throws(() => validateAppImageHeader(appImageHeader('x64'), 'ia32'))
})

test('AppImage paths reject symlinks, hardlinks, non-executable files and foreign filenames', async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'inkleaf-appimage-fixture-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'Inkleaf.AppImage')
  await writeFile(filename, appImageHeader('x64'), { mode: 0o700 })
  await assert.doesNotReject(validateAppImageFile(filename, 'x64', true))
  assert.equal(await appImageTarget(filename, 'x64'), filename)
  const alias = path.join(directory, 'Inkleaf-alias.AppImage')
  await symlink(filename, alias)
  await assert.rejects(appImageTarget(alias, 'x64'))
  const hardlink = path.join(directory, 'Inkleaf-hardlink.AppImage')
  await link(filename, hardlink)
  await assert.rejects(validateAppImageFile(filename, 'x64'))
  await rm(hardlink)
  await chmod(filename, 0o600)
  await assert.rejects(appImageTarget(filename, 'x64'))
  await chmod(filename, 0o700)
  await assert.rejects(appImageTarget(path.join(directory, 'Other.AppImage'), 'x64'))
  await assert.rejects(appImageTarget(undefined, 'x64'))
  await assert.rejects(appImageTarget('Inkleaf.AppImage', 'x64'))
})

test('Linux native helper replaces atomically, keeps backup, verifies both payloads and observes boot ACK', { skip: process.platform !== 'linux' }, async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'inkleaf-linux-helper-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const helper = path.join(directory, 'install-helper'), fixture = path.join(directory, 'fixture.c')
  execFileSync('gcc', ['-O2', '-Wall', '-Wextra', 'scripts/update-helper-linux.c', '-o', helper])
  await writeFile(fixture, `#include <stdio.h>\n#include <stdlib.h>\nint main(int argc,char **argv) { if(argc==3) { FILE *f=fopen(getenv("INKLEAF_FIXTURE_ACK"),"w"); if(!f)return 1; fputs(argv[2],f); fclose(f); } return 0; }\n`)
  const original = path.join(directory, 'runtime')
  execFileSync('gcc', [fixture, '-o', original])
  const executable = await readFile(original)
  executable.set([0x41, 0x49, 0x02], 8)
  await writeFile(original, executable, { mode: 0o700 })
  const nonce = 'a1'.repeat(24)
  const { createHash } = await import('node:crypto')
  const digest = createHash('sha256').update(executable).digest('hex')
  const target = path.join(directory, 'Inkleaf.AppImage')
  await copyFile(original, target); await chmod(target, 0o700)
  const job = path.join(directory, '.inkleaf-update-success')
  await mkdir(job, { mode: 0o700 })
  const staged = path.join(job, 'Inkleaf.AppImage'), source = path.join(job, 'download.AppImage')
  await copyFile(original, staged); await chmod(staged, 0o700)
  await copyFile(original, source)
  const ack = path.join(job, 'boot-ack'), result = path.join(job, 'result.json')
  execFileSync(helper, [target, staged, source, digest, '2147483647', ack, nonce, '0.3.0', result], { env: { ...process.env, INKLEAF_FIXTURE_ACK: ack }, timeout: 10000 })
  assert.equal(await readFile(ack, 'utf8'), nonce)
  const receipt = JSON.parse(await readFile(result, 'utf8'))
  assert.equal(receipt.state, 'installed')
  assert.equal(receipt.version, '0.3.0')
  assert.deepEqual(await readFile(receipt.backupPath), executable)
  assert.deepEqual(await readFile(target), executable)
  // A valid download cannot authorize a modified staged executable.
  const badJob = path.join(directory, '.inkleaf-update-tampered')
  await mkdir(badJob, { mode: 0o700 })
  const badStage = path.join(badJob, 'Inkleaf.AppImage')
  await copyFile(original, badStage); await chmod(badStage, 0o700)
  const altered = Buffer.from(executable); altered[altered.length - 1] ^= 1
  await writeFile(badStage, altered)
  const badResult = path.join(badJob, 'result.json')
  assert.throws(() => execFileSync(helper, [target, badStage, source, digest, '2147483647', path.join(badJob, 'boot-ack'), nonce, '0.3.0', badResult]))
  assert.equal(JSON.parse(await readFile(badResult, 'utf8')).state, 'error')
  assert.deepEqual(await readFile(target), executable)
})

test('redirect allowlist accepts GitHub HTTPS assets only and isolates API requests', () => {
  for (const url of [
    'https://github.com/Fovercon/Inkleaf/releases/download/v0.3.0/app.zip',
    'https://release-assets.githubusercontent.com/github-production-release-asset/123?token=temporary',
    'https://objects.githubusercontent.com/github-production-release-asset/123',
    'https://github.com:443/Fovercon/Inkleaf'
  ]) assert.doesNotThrow(() => validateDownloadHost(url))
  assert.doesNotThrow(() => validateDownloadHost('https://api.github.com/repos/Fovercon/Inkleaf/releases/latest', true))
  for (const url of [
    'http://github.com/file.zip',
    'https://github.com.evil.example/file.zip',
    'https://evilgithub.com/file.zip',
    'https://github.com@evil.example/file.zip',
    'https://user:password@github.com/file.zip',
    'https://github.com:8443/file.zip',
    'https://localhost/file.zip',
    'file:///tmp/file.zip',
    'https://api.github.com/file.zip'
  ]) assert.throws(() => validateDownloadHost(url))
  assert.throws(() => validateDownloadHost('https://github.com/Fovercon/Inkleaf', true))
  assert.throws(() => validateDownloadHost('https://release-assets.githubusercontent.com/file.zip', true))
})

type FixtureEntry = { name: string; data?: string; compress?: boolean; kind?: 'file' | 'directory' | 'symlink' | 'fifo' | 'socket' }
const essentials: FixtureEntry[] = [
  { name: 'Inkleaf.app/Contents/Info.plist', data: '<plist><dict/></plist>' },
  { name: 'Inkleaf.app/Contents/MacOS/Inkleaf', data: 'fixture executable' }
]
// Python's standard ZIP writer lets fixtures encode Unix symlinks and special
// files without adding a package, or extracting any untrusted fixture paths.
const fixtureWriter = `
import json, stat, sys, warnings, zipfile
warnings.simplefilter('ignore', UserWarning)
modes = {'file': stat.S_IFREG | 0o644, 'directory': stat.S_IFDIR | 0o755, 'symlink': stat.S_IFLNK | 0o777, 'fifo': stat.S_IFIFO | 0o600, 'socket': stat.S_IFSOCK | 0o600}
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for entry in json.load(sys.stdin):
        info = zipfile.ZipInfo(entry['name'])
        info.create_system = 3
        info.compress_type = zipfile.ZIP_DEFLATED if entry.get('compress') else zipfile.ZIP_STORED
        kind = entry.get('kind', 'directory' if entry['name'].endswith('/') else 'file')
        info.external_attr = modes[kind] << 16
        archive.writestr(info, entry.get('data', '').encode('utf-8'))
`
async function fixture(t: TestContext, entries: FixtureEntry[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inkleaf-zip-fixture-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'update.zip')
  execFileSync('python3', ['-c', fixtureWriter, filename], { input: JSON.stringify(entries), stdio: ['pipe', 'ignore', 'pipe'] })
  return filename
}

test('normal Inkleaf ZIP accepts framework version links inside its application', async t => {
  const entries: FixtureEntry[] = [
    { name: 'Inkleaf.app/', kind: 'directory' },
    ...essentials,
    { name: 'Inkleaf.app/Contents/Frameworks/Electron.framework/Versions/A/Electron', data: 'framework binary' },
    { name: 'Inkleaf.app/Contents/Frameworks/Electron.framework/Versions/A/Resources/Info.plist', data: 'framework plist' },
    { name: 'Inkleaf.app/Contents/Frameworks/Electron.framework/Versions/Current', kind: 'symlink', data: 'A' },
    { name: 'Inkleaf.app/Contents/Frameworks/Electron.framework/Electron', kind: 'symlink', data: 'Versions/Current/Electron' },
    { name: 'Inkleaf.app/Contents/Frameworks/Electron.framework/Resources', kind: 'symlink', data: 'Versions/Current/Resources' }
  ]
  await assert.doesNotReject(validateArchive(await fixture(t, entries)))
})

test('ZIP rejects traversal paths and entries outside the application root', async t => {
  for (const name of [
    '../outside.txt',
    '/tmp/outside.txt',
    'Inkleaf.app/Contents/../../outside.txt',
    'Inkleaf.app/Contents/./Info.plist',
    'Inkleaf.app\\Contents\\outside.txt',
    'Other.app/Contents/Info.plist',
    'README.txt'
  ]) {
    await t.test(name, async sub => {
      await assert.rejects(validateArchive(await fixture(sub, [...essentials, { name, data: 'malicious' }])))
    })
  }
})

test('ZIP rejects absolute and root-escaping symlink targets', async t => {
  for (const target of ['/Applications/Other.app', '../../../outside', '../../../../tmp/file', 'C:\\outside']) {
    await t.test(target, async sub => {
      await assert.rejects(validateArchive(await fixture(sub, [...essentials, {
        name: 'Inkleaf.app/Contents/Resources/escape', kind: 'symlink', data: target
      }])))
    })
  }
})

test('ZIP rejects writing descendants through symlinks regardless of entry order', async t => {
  const link: FixtureEntry = { name: 'Inkleaf.app/Contents/Resources/linked', kind: 'symlink', data: 'real' }
  const child: FixtureEntry = { name: 'Inkleaf.app/Contents/Resources/linked/payload.txt', data: 'write-through' }
  for (const [description, entries] of [['link before child', [link, child]], ['link after child', [child, link]]] as const) {
    await t.test(description, async sub => {
      await assert.rejects(validateArchive(await fixture(sub, [...essentials, ...entries])))
    })
  }
})

test('ZIP cannot hide a symlink descendant behind a similarly named sibling', async t => {
  await assert.rejects(validateArchive(await fixture(t, [...essentials,
    { name: 'Inkleaf.app/Contents/Resources/link', kind: 'symlink', data: 'real' },
    { name: 'Inkleaf.app/Contents/Resources/link-sibling', data: 'sorts before link/payload' },
    { name: 'Inkleaf.app/Contents/Resources/link/payload.txt', data: 'write-through' }
  ])))
})

test('ZIP rejects files used as parent directories', async t => {
  await assert.rejects(validateArchive(await fixture(t, [...essentials,
    { name: 'Inkleaf.app/Contents/Resources/file-parent', data: 'ordinary file' },
    { name: 'Inkleaf.app/Contents/Resources/file-parent/payload.txt', data: 'conflicting child' }
  ])))
})

test('ZIP rejects duplicate extraction paths', async t => {
  await assert.rejects(validateArchive(await fixture(t, [...essentials, { ...essentials[0], data: 'replacement plist' }])))
})

test('ZIP rejects duplicate paths hidden behind repeated separators', async t => {
  await assert.rejects(validateArchive(await fixture(t, [...essentials, {
    name: 'Inkleaf.app/Contents//Info.plist', data: 'replacement plist'
  }])))
})

test('ZIP rejects case aliases of the same extraction path on macOS', async t => {
  await assert.rejects(validateArchive(await fixture(t, [...essentials, {
    name: 'Inkleaf.app/Contents/info.plist', data: 'replacement plist through case alias'
  }])))
})

test('ZIP rejects symlink descendants hidden behind a case alias', async t => {
  await assert.rejects(validateArchive(await fixture(t, [...essentials,
    { name: 'Inkleaf.app/Contents/Resources/link', kind: 'symlink', data: 'real' },
    { name: 'Inkleaf.app/Contents/Resources/LINK/payload.txt', data: 'case alias write-through' }
  ])))
})

test('ZIP rejects Unicode normalization aliases of the same extraction path', async t => {
  const nfc = 'Inkleaf.app/Contents/Resources/caf\u00e9.txt'
  const nfd = 'Inkleaf.app/Contents/Resources/cafe\u0301.txt'
  assert.notEqual(nfc, nfd)
  await assert.rejects(validateArchive(await fixture(t, [...essentials,
    { name: nfc, data: 'first entry' },
    { name: nfd, data: 'same filesystem path in decomposed Unicode' }
  ])))
})

test('ZIP requires both essential application files', async t => {
  for (const [description, entries] of [['missing plist', [essentials[1]]], ['missing executable', [essentials[0]]], ['empty archive', []]] as const) {
    await t.test(description, async sub => {
      await assert.rejects(validateArchive(await fixture(sub, [...entries])))
    })
  }
})

test('ZIP rejects Unix special files', async t => {
  for (const kind of ['fifo', 'socket'] as const) {
    await t.test(kind, async sub => {
      await assert.rejects(validateArchive(await fixture(sub, [...essentials, {
        name: `Inkleaf.app/Contents/Resources/${kind}`, kind
      }])))
    })
  }
})

test('ZIP rejects deflated payloads that under-report their actual uncompressed size', async t => {
  const entryName = 'Inkleaf.app/Contents/Resources/low-reported.txt'
  const actualSize = 1024 * 1024
  const filename = await fixture(t, [...essentials, {
    name: entryName, data: 'A'.repeat(actualSize), compress: true
  }])
  const data = await readFile(filename)
  // Alter both size declarations. Looking only at local-vs-central consistency
  // cannot detect this archive; it must inflate the regular file and count bytes.
  for (const header of [
    { signature: Buffer.from([0x50, 0x4b, 0x03, 0x04]), nameLength: 26, nameStart: 30, size: 22 },
    { signature: Buffer.from([0x50, 0x4b, 0x01, 0x02]), nameLength: 28, nameStart: 46, size: 24 }
  ]) {
    let offset = data.indexOf(header.signature)
    let patched = false
    while (offset >= 0) {
      const length = data.readUInt16LE(offset + header.nameLength)
      const name = data.subarray(offset + header.nameStart, offset + header.nameStart + length).toString('utf8')
      if (name === entryName) {
        assert.equal(data.readUInt32LE(offset + header.size), actualSize)
        data.writeUInt32LE(1, offset + header.size)
        patched = true
        break
      }
      offset = data.indexOf(header.signature, offset + header.signature.length)
    }
    assert.ok(patched, 'Fixture must alter both the local and central size fields')
  }
  await writeFile(filename, data)
  await assert.rejects(validateArchive(filename))
})
