// Recovery may reuse only native Linux checks and artifacts for the exact tagged source.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
export function validateReuse(run, jobs, source, repository) {
  assert.equal(run.repository?.full_name, repository, 'Artifact repository mismatch')
  assert.equal(run.head_sha, source, 'Artifact source does not match the tag')
  assert.equal(run.status, 'completed', 'Source workflow must finish before recovery')
  assert.ok(['.github/workflows/release.yml', '.github/workflows/linux.yml'].includes(run.path), 'Unexpected source workflow')
  const prefix = run.path.endsWith('/release.yml') ? 'linux / ' : ''
  for (const name of ['linux (x64, ubuntu-22.04)', 'linux (arm64, ubuntu-24.04-arm)', 'Ubuntu 24.04 x64 compatibility']) {
    const matching = jobs.filter(job => job.name === prefix + name)
    assert.equal(matching.length, 1, `Expected one native check: ${name}`)
    assert.equal(matching[0].status, 'completed', `Incomplete native check: ${name}`)
    assert.equal(matching[0].conclusion, 'success', `Failed native check: ${name}`)
  }
  if (prefix) {
    assert.equal(jobs.find(job => job.name === 'validate')?.conclusion, 'success', 'Original release identity check failed')
    assert.ok(['cancelled', 'success'].includes(jobs.find(job => job.name === 'mac')?.conclusion), 'Investigate actual macOS test failures before recovery')
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.env.RELEASE_TAG, id = process.env.LINUX_RUN_ID, repository = process.env.GH_REPO
  assert.match(tag || '', /^v\d+\.\d+\.\d+$/)
  assert.match(id || '', /^[1-9]\d{0,15}$/)
  assert.match(repository || '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  const source = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim()
  execFileSync('git', ['merge-base', '--is-ancestor', source, 'origin/main'])
  const pkg = JSON.parse(execFileSync('git', ['show', `${tag}:package.json`], { encoding: 'utf8' }))
  assert.equal(tag, `v${pkg.version}`, 'Tag and package version mismatch')
  const api = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))
  const run = api(`repos/${repository}/actions/runs/${id}`)
  const response = api(`repos/${repository}/actions/runs/${id}/jobs?filter=latest&per_page=100`)
  assert.ok(response.total_count <= 100, 'Incomplete job response')
  validateReuse(run, response.jobs, source, repository)
  console.log(`Verified native Linux checks for ${tag} at ${source}, workflow ${id}`)
}
