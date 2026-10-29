import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresPluginAccessStore } from '../src/adapters/postgres-plugin-access-store.js'
import { PostgresPluginUpstreams } from '../src/adapters/postgres-plugin-upstreams.js'
import { declaredRuntimeRevision, pluginCompatibilityTarget } from '../src/adapters/runtime-revision.js'
import { createCommunityApplication, openTestAccounts, openTestDatabase } from './support/community-application.js'
import { withPluginFacts } from './support/plugin-facts.js'

it('opens an empty skill library without changing existing PostgreSQL plugin facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-plugins-'))
  const accounts = await openTestAccounts(root),
    admin = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' }),
    group = await accounts.createGroup('Existing team')
  await accounts.close()
  const current = {
    packageName: 'example-plugin',
    version: '1.0.0',
    artifact: 'artifacts/fixture',
    integrity: `sha512-${'A'.repeat(86)}==`,
    runtimeRevision: declaredRuntimeRevision(),
    title: 'Existing plugin',
    description: 'Retain me',
    bundlePatch: JSON.stringify([{ insert: [{ id: 'example', name: 'example-plugin' }] }]),
    dependencies: {},
  }
  await withPluginFacts(root, async ({ library, grants, local }) => {
    await library.save({
      packageName: current.packageName,
      version: current.version,
      stage: 'available',
      current,
      published: true,
      checkedFor: pluginCompatibilityTarget(),
    })
    await grants.set(group.id, ['example-plugin'])
    await local.set(admin.spaceId, ['example-plugin'])
  })
  const database = await openTestDatabase(root),
    access = new PostgresPluginAccessStore(database),
    upstreams = new PostgresPluginUpstreams(database)
  await access.initialize()
  await upstreams.initialize()
  await access.save('example-plugin', { entriesYaml: '', entries: {}, environment: [] })
  await upstreams.save('example-plugin', [{ name: 'existing', baseUrl: 'https://example.test', credential: 'fixture-only', headers: [] }])
  const snapshot = () =>
    withPluginFacts(root, async ({ library, grants, local, selections }) => ({
      library: await library.list(),
      grants: await grants.get(group.id),
      local: await local.get(admin.spaceId),
      selected: await selections.get(admin.spaceId),
    }))
  const before = await snapshot(),
    beforeAccess = await access.get('example-plugin'),
    beforeUpstreams = await upstreams.list('example-plugin')
  const app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'existing-skills-upgrade-fixture-secret',
    runtime: {
      command: '/unavailable',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
    },
  })
  try {
    const origin = await app.start(),
      login = await fetch(origin + '/login', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'admin', password: 'password' }),
      })
    const cookie = login.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
    const get = async (path: string) => {
      const response = await fetch(origin + path, { headers: { cookie } })
      expect(response.status).toBe(200)
      return response.json()
    }
    expect(await get('/admin/api/skills')).toEqual([])
    expect(await get('/admin/api/plugins')).toEqual([expect.objectContaining({ packageName: 'example-plugin', currentVersion: '1.0.0', published: true })])
    expect(await get('/admin/api/groups')).toContainEqual(expect.objectContaining({ id: group.id, pluginCount: 1 }))
    expect(await snapshot()).toEqual(before)
    expect(await access.get('example-plugin')).toEqual(beforeAccess)
    expect(await upstreams.list('example-plugin')).toEqual(beforeUpstreams)
  } finally {
    await app.stop()
    await database.close()
    await removeCommunityFixture(root)
  }
})
