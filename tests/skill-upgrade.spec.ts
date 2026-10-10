import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { declaredRuntimeRevision, pluginCompatibilityTarget } from '../src/adapters/runtime-revision.js'

it('opens an empty skill library alongside the 0.1.8 plugin carriers without changing their grants, upstreams or access settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-legacy-'))
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  const admin = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
  const group = accounts.createGroup('Existing team'); accounts.close()
  const current = { packageName: 'example-plugin', version: '1.0.0', artifact: 'artifacts/fixture', integrity: `sha512-${'A'.repeat(86)}==`, runtimeRevision: declaredRuntimeRevision(), title: 'Existing plugin', description: 'Retain me', bundlePatch: JSON.stringify([{ insert: [{ id: 'example', name: 'example-plugin' }] }]), dependencies: {} }
  // Schema 1 carriers from 0.1.8. Runtime compatibility has already been checked;
  // this seam isolates skill initialization from the existing plugin recheck protocol.
  const fixtures = {
    'plugins/library.json': { schema: 1, plugins: [{ packageName: current.packageName, version: current.version, stage: 'available', current, published: true, checkedFor: pluginCompatibilityTarget() }] },
    'plugins/grants.json': { schema: 1, groups: { [group.id]: ['example-plugin'] } },
    'plugins/selections.json': { schema: 1, spaces: { [admin.spaceId]: ['example-plugin'] } },
    'plugins/access.json': { schema: 1, plugins: { 'example-plugin': { entriesYaml: '{}', entries: {}, environment: [], revision: 'existing-access' } } },
    'plugin-upstreams.json': { schema: 1, plugins: { 'example-plugin': [{ name: 'existing', baseUrl: 'https://example.test', credential: 'fixture-only', headers: [] }] } },
  }
  await mkdir(join(root, 'plugins'))
  for (const [path, data] of Object.entries(fixtures)) await writeFile(join(root, path), JSON.stringify(data), { mode: 0o600 })
  const before = await Promise.all(Object.keys(fixtures).map(path => readFile(join(root, path))))
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'existing-skills-upgrade-fixture-secret', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } })
  try {
    const origin = await app.start()
    const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password: 'password' }) })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const get = async (path: string) => { const response = await fetch(origin + path, { headers: { cookie } }); expect(response.status).toBe(200); return response.json() }
    expect(await get('/admin/api/skills')).toEqual([])
    expect(await get('/admin/api/plugins')).toEqual([expect.objectContaining({ packageName: 'example-plugin', currentVersion: '1.0.0', published: true })])
    expect(await get('/admin/api/groups')).toContainEqual(expect.objectContaining({ id: group.id, pluginCount: 1 }))
    expect(await Promise.all(Object.keys(fixtures).map(path => readFile(join(root, path))))).toEqual(before)
  } finally { await app.stop(); await rm(root, { recursive: true, force: true }) }
})
