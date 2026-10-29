import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { prepareManagedPlugins } from '../src/adapters/managed-plugins.js'
import { YamlPluginAccessSyntax } from '../src/adapters/plugin-access-syntax.js'
import { PostgresPluginAccessStore } from '../src/adapters/postgres-plugin-access-store.js'
import { createCommunityApplication, openTestDatabase } from './support/community-application.js'
import { seedPluginParents, withPluginFacts } from './support/plugin-facts.js'
async function openAccess(database: Awaited<ReturnType<typeof openTestDatabase>>) {
  const store = new PostgresPluginAccessStore(database)
  await seedPluginParents(database, ['plugin', 'editor', 'new-editor'])
  await store.initialize()
  return store
}

it('persists private templates without churning unchanged revisions and merges only owned startup entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'access-storage-'))
  const database = await openTestDatabase(root)
  try {
    const store = await openAccess(database)
    const settings = { environment: [{ name: 'PLUGIN_TOKEN', value: '{access-token}' }], entriesYaml: 'main: {}', entries: { main: {} } }
    await store.save('plugin', settings)
    const revision = (await store.get('plugin'))!.revision
    await store.save('plugin', settings)
    expect((await store.get('plugin'))!.revision).toBe(revision)
    expect(await (await openAccess(database)).get('plugin')).toEqual(await store.get('plugin'))
    await store.remove('plugin')
    await store.save('plugin', settings)
    expect((await store.get('plugin'))!.revision).not.toBe(revision)
    const prefix = 'phalanx-managed-' + createHash('sha256').update('plugin').digest('hex').slice(0, 16)
    const prepared = join(root, 'plugins/artifacts/hash/prepared/rev')
    await mkdir(prepared, { recursive: true })
    const filename = prefix + '-entries-0.json'
    const original = [
      {
        id: prefix + '-main',
        name: '/artifact/node_modules/plugin/index.js',
        config: { tools: { a: false, b: true }, list: ['original'], lazy: { __jsExpr: 'process.env.SAFE' } },
      },
    ]
    await writeFile(join(prepared, filename), JSON.stringify(original))
    await writeFile(join(prepared, 'managed.patch.json'), JSON.stringify([{ insert: [{ config: { path: '/artifact/' + filename } }] }]))
    const plugin = {
      packageName: 'plugin',
      version: '1.0.0',
      artifact: 'artifacts/hash',
      integrity: 'hash',
      runtimeRevision: 'rev',
      bundlePatch: '- insert:\n  - id: main\n    name: plugin\n',
      dependencies: {},
      title: '',
      description: '',
    }
    expect(new YamlPluginAccessSyntax().entryIds(plugin)).toEqual(['main'])
    const mount = await prepareManagedPlugins(root, 'space', [plugin], true, {
      plugin: { main: { tools: { a: true }, list: [1], key: { __jsExpr: 'process.env.PRIVATE_KEY' } }, removed: { key: 'ignored' } },
    })
    expect(mount!.failures).toEqual([])
    const output = JSON.parse(await readFile(join(root, 'plugins/instances/space', filename), 'utf8'))
    expect(output[0].config).toEqual({
      tools: { a: true, b: true },
      list: [1],
      lazy: { __jsExpr: 'process.env.SAFE' },
      key: { __jsExpr: 'process.env.PRIVATE_KEY' },
    })
    expect(JSON.parse(await readFile(join(prepared, filename), 'utf8'))).toEqual(original)
  } finally {
    await database.close()
    await removeCommunityFixture(root)
  }
})

it('atomically checkpoints and exactly restores settings, absence and contribution receipts across reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'access-checkpoint-'))
  const database = await openTestDatabase(root)
  try {
    const store = await openAccess(database)
    const before = { environment: [{ name: 'MODE', value: 'manual' }], entriesYaml: '', entries: {} }
    const next = { environment: [{ name: 'MODE', value: 'catalog' }], entriesYaml: '', entries: {} }
    const receipt = { id: 'contribution', revision: 'first' }
    await store.save('editor', before, receipt)
    const original = await store.get('editor')
    await store.applySuite('editor', 'suite:editor', next)
    const reopened = await openAccess(database)
    await reopened.applySuite('editor', 'suite:editor', next)
    expect((await reopened.suiteCheckpoint('editor'))?.before).toEqual(original)
    expect(await reopened.restoreSuite('editor', 'suite:editor')).toBe(true)
    expect(await reopened.get('editor')).toEqual(original)
    expect(await reopened.receipt('editor')).toEqual(receipt)
    await reopened.applySuite('new-editor', 'suite:new', next)
    expect(await (await openAccess(database)).restoreSuite('new-editor', 'suite:new')).toBe(true)
    expect(await (await openAccess(database)).get('new-editor')).toBeUndefined()
    await reopened.applySuite('editor', 'suite:edited', next)
    await reopened.save('editor', { ...before, environment: [{ name: 'MODE', value: 'changed' }] })
    expect(await reopened.restoreSuite('editor', 'suite:edited')).toBe(false)
    expect((await reopened.suiteCheckpoint('editor'))?.task).toBe('suite:edited')
    expect((await reopened.get('editor'))?.environment[0]?.value).toBe('changed')
  } finally {
    await database.close()
    await removeCommunityFixture(root)
  }
})

it('saves plugin access through PostgreSQL and reopens without a JSON backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-access-application-'))
  await withPluginFacts(root, async ({ library }) =>
    library.save({
      packageName: 'plugin',
      version: '1.0.0',
      current: null,
      stage: 'failed',
      published: false,
    }),
  )
  const make = () =>
    createCommunityApplication({
      listen: { host: '127.0.0.1', port: 0 },
      runtime: {
        command: '/unavailable-dsh',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      },
    })
  let application = make()
  try {
    let origin = await application.start()
    const bootstrap = await fetch(origin + '/bootstrap', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }),
    })
    const cookie = bootstrap.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; '),
      path = '/admin/api/plugins/access?packageName=plugin'
    const input = { environment: [{ name: 'PRIVATE_KEY', value: 'fictional-plugin-access-http-key' }], entriesYaml: '' }
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    expect(response.status).toBe(200)
    const saved = await response.json()
    expect(await readdir(join(root, 'plugins')).catch(() => [])).not.toContain('access.json')
    const database = await openTestDatabase(root)
    try {
      const rows = JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.plugin_access_secrets'))
      expect(rows).toContain('ciphertext')
      expect(rows).not.toContain(input.environment[0]!.value)
    } finally {
      await database.close()
    }
    await application.stop()
    application = make()
    origin = await application.start()
    expect(await (await fetch(origin + path, { headers: { cookie } })).json()).toEqual(saved)
  } finally {
    await application.stop()
    await removeCommunityFixture(root)
  }
})
