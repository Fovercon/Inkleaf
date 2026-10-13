// A single publication job receives only assets from successful native builds.
// Never publish an incomplete platform set or replace an already public release.
import { createReadStream } from 'node:fs'
import { readFile, stat, appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'

const [directory, verifyOnly] = process.argv.slice(2)
if (!directory || (verifyOnly && verifyOnly !== '--verify-only')) throw new Error('Usage: node scripts/publish-release.mjs <asset-directory> [--verify-only]')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Expected a stable package version')
const filenames = [`Inkleaf-${pkg.version}-mac-arm64.zip`]
for (const arch of ['x64', 'arm64']) for (const ext of ['AppImage', 'deb']) filenames.push(`Inkleaf-${pkg.version}-linux-${arch}.${ext}`)
const hashes = new Map()
const files = []
for (const basename of filenames) {
  const filename = path.join(directory, basename)
  const checksum = `${filename}.sha256`
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  const expected = hash.digest('hex')
  if ((await readFile(checksum, 'utf8')) !== `${expected}  ${basename}\n`) throw new Error(`Checksum mismatch: ${basename}`)
  hashes.set(basename, expected)
  files.push(filename, checksum)
}
console.log('Verified all five platform assets and their SHA-256 files')
if (verifyOnly) process.exit(0)

const tag = process.env.RELEASE_TAG
if (tag !== `v${pkg.version}`) throw new Error('Release tag must match package.json')
const repo = process.env.GH_REPO
if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('GH_REPO must identify the release repository')
const existing = spawnSync('gh', ['release', 'view', tag, '--json', 'isDraft'], { encoding: 'utf8' })
if (existing.error) throw existing.error
if (existing.status === 0) {
  if (!JSON.parse(existing.stdout).isDraft) throw new Error('Refusing to overwrite a published release')
} else if (/release not found/i.test(existing.stderr)) {
  execFileSync('gh', ['release', 'create', tag, '--draft', '--verify-tag', '--title', `墨页 · Inkleaf ${pkg.version}`, '--generate-notes'], { stdio: 'inherit' })
} else throw new Error(existing.stderr || 'Failed to inspect the release')
execFileSync('gh', ['release', 'upload', tag, ...files, '--clobber'], { stdio: 'inherit' })

// Require server-side digests as well; clients verify the GitHub API digest.
const pages = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/releases?per_page=100`, '--paginate', '--slurp'], { encoding: 'utf8' }))
const matchingReleases = pages.flat().filter(release => release.tag_name === tag)
if (matchingReleases.length !== 1 || !Number.isSafeInteger(matchingReleases[0].id)) throw new Error('Expected exactly one release ID for this tag')
const uploaded = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/releases/${matchingReleases[0].id}`], { encoding: 'utf8' }))
if (!uploaded.draft) throw new Error('Release was published by another process while uploading')
for (const filename of files) {
  const basename = path.basename(filename)
  const matching = uploaded.assets.filter(asset => asset.name === basename)
  if (matching.length !== 1 || matching[0].state !== 'uploaded' || matching[0].size !== (await stat(filename)).size) throw new Error(`Uploaded asset is incomplete: ${basename}`)
  if (hashes.has(basename) && matching[0].digest !== `sha256:${hashes.get(basename)}`) throw new Error(`GitHub digest mismatch: ${basename}`)
}
if (process.env.PUBLISH_RELEASE === 'true') execFileSync('gh', ['release', 'edit', tag, '--draft=false', '--latest'], { stdio: 'inherit' })
const result = `Release: https://github.com/${repo}/releases/tag/${tag}\nAll macOS and Linux assets passed validation. ${process.env.PUBLISH_RELEASE === 'true' ? 'Published.' : 'Saved as draft; publish after reviewing the notes.'}\n`
console.log(result)
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, result)
