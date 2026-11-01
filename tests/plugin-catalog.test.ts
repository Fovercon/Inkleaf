import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import shipped from '../resources/plugin-catalog.json'
import { validateCatalog, PluginCatalogService, CATALOG_URL } from '../src/main/plugin-catalog'
import { comparePluginVersions } from '../src/shared/plugins'
const copy = () => JSON.parse(JSON.stringify(shipped))

test('stable version comparison is numeric and rejects ambiguous inputs', () => {
  assert.equal(comparePluginVersions('1.10.0', '1.9.9'), 1)
  assert.equal(comparePluginVersions('2.0.0', '10.0.0'), -1)
  assert.equal(comparePluginVersions('1.0.0', '1.0.0'), 0)
  for (const value of ['01.0.0', '1.0', '1.0.0-beta', '9007199254740992.0.0']) assert.equal(comparePluginVersions(value, '1.0.0'), null)
})
test('official payload validation rejects tampering, traversal, permission mismatch and unsupported schema', () => {
  assert.equal(validateCatalog(copy()).entries.length, 3)
  const mutations = [
    (c: any) => c.schema = 2,
    (c: any) => c.entries.push(c.entries[0]),
    (c: any) => c.entries[1].files['main.mjs'] += 'tampered',
    (c: any) => c.entries[1].files['../escape.mjs'] = 'bad',
    (c: any) => c.entries[1].permissions.push('documents:write'),
    (c: any) => c.entries[1].version = '99.0.0',
    (c: any) => c.entries[1].examples = ['invalid'],
  ]
  for (const mutate of mutations) { const c = copy(); mutate(c); assert.throws(() => validateCatalog(c)) }
})
test('online refresh uses the fixed source, persists cache, and retains a working catalog on HTTP failure', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'inkleaf-catalog-')); t.after(() => rm(profile, { recursive: true, force: true }))
  let requests = 0, failed = false
  const service = new PluginCatalogService(profile, (async (url: string, options: any) => {
    requests++; assert.equal(url, CATALOG_URL); assert.equal(options.redirect, 'error')
    return failed ? new Response('not found', { status: 404 }) : new Response(JSON.stringify(shipped), { status: 200 })
  }) as any)
  assert.equal((await service.get()).source, 'bundled')
  const [a, b] = await Promise.all([service.check(), service.check()])
  assert.equal(requests, 1); assert.equal(a.source, 'online'); assert.equal(b.source, 'online')
  assert.equal(a.entries.some((e: any) => e.files), false)
  assert.equal(JSON.parse(await readFile(path.join(profile, 'plugin-catalog-cache.json'), 'utf8')).schema, 1)
  const cached = new PluginCatalogService(profile)
  assert.equal((await cached.get()).source, 'cache')
  failed = true
  const fallback = await service.check()
  assert.equal(fallback.entries.length, 3); assert.match(fallback.warning!, /404/)
  assert.equal((await service.package('inkleaf.reading-time', '1.0.0')).id, 'inkleaf.reading-time')
})
test('a malformed or oversized remote directory cannot overwrite a validated cache', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'inkleaf-catalog-')); t.after(() => rm(profile, { recursive: true, force: true }))
  let response = JSON.stringify(shipped)
  const service = new PluginCatalogService(profile, (async () => new Response(response)) as any)
  await service.check()
  for (const bad of ['{}', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    response = bad; const result = await service.check()
    assert.ok(result.warning); assert.equal(result.entries.length, 3)
    assert.equal((await new PluginCatalogService(profile).get()).source, 'cache')
  }
})
