import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { prepareManagedPlugins } from '../src/adapters/managed-plugins.js'
import { PostgresPluginAccessStore } from '../src/adapters/postgres-plugin-access-store.js'
import { MemberPluginAccess } from '../src/use-cases/member-plugin-access.js'
import { openTestDatabase } from './support/community-application.js'
import { seedPluginParents } from './support/plugin-facts.js'

it('projects managed and expert access strings as environment references without resolved tokens or YAML values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-access-projection-')),
    database = await openTestDatabase(root),
    store = new PostgresPluginAccessStore(database)
  const token = 'fictional-member-access-token',
    key = 'fictional-managed-environment-key',
    yamlKey = 'fictional-yaml-only-access-key'
  try {
    await seedPluginParents(database)
    await store.initialize()
    const prefix = 'phalanx-managed-' + createHash('sha256').update('plugin').digest('hex').slice(0, 16),
      filename = prefix + '-entries-0.json'
    const prepared = join(root, 'plugins/artifacts/hash/prepared/rev')
    await mkdir(prepared, { recursive: true })
    await writeFile(
      join(prepared, filename),
      JSON.stringify([{ id: prefix + '-main', name: '/artifact/node_modules/plugin/index.js', config: { retained: true, key: { previous: true } } }]),
    )
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
    await store.save('plugin', {
      environment: [{ name: 'PRIVATE_KEY', value: key }],
      entriesYaml: 'protected',
      entries: { main: { key: yamlKey, member: 'prefix-{access-token}', nested: [key, true, 3] } },
    })
    const memberAccess = new MemberPluginAccess({ effective: async () => [plugin] }, store)
    const resolved = await memberAccess.resolve([plugin], { token, url: 'https://platform.example' })
    expect(resolved.environment.PRIVATE_KEY).toBe(key)
    expect(JSON.stringify(resolved.entries)).not.toContain(token)
    expect(JSON.stringify(resolved.entries)).not.toContain(key)
    expect(JSON.stringify(resolved.entries)).not.toContain(yamlKey)
    for (const global of [true, false]) {
      const mounts = await prepareManagedPlugins(root, 'space', [plugin], true, resolved.entries, global ? ['plugin'] : [])
      expect(mounts!.failures).toEqual([])
      const bytes = await readFile(join(root, 'plugins/instances/space', filename), 'utf8')
      for (const value of [token, key, yamlKey]) expect(bytes).not.toContain(value)
      const configuration = JSON.parse(bytes)[0].config
      const evaluate = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(evaluate)
        if (value && typeof value === 'object') {
          if ('__jsExpr' in value) return runInNewContext(String(value.__jsExpr), { process: { env: resolved.environment } })
          return Object.fromEntries(Object.entries(value).map(([name, row]) => [name, evaluate(row)]))
        }
        return value
      }
      expect(evaluate(configuration)).toEqual({ retained: true, key: yamlKey, member: 'prefix-' + token, nested: [key, true, 3] })
      expect(JSON.stringify(mounts!.expertEntries)).not.toContain(token)
    }
  } finally {
    await store.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps native access snapshots free of literal secrets while still detecting changed effective values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-access-native-snapshot-')),
    database = await openTestDatabase(root),
    store = new PostgresPluginAccessStore(database)
  const key = 'fictional-native-access-key'
  try {
    await seedPluginParents(database)
    await store.initialize()
    await store.save('plugin', { environment: [{ name: 'PRIVATE_KEY', value: key }], entriesYaml: '', entries: {} })
    const account = {
      username: 'member',
      spaceId: 'space',
      sessionEpoch: 0,
      disabled: false,
      admin: false,
      groupId: 'group',
      email: '',
      createdAt: 0,
      updatedAt: 0,
    }
    const access = new MemberPluginAccess({ effective: async () => [] }, store, {
      accounts: { get: async () => account },
      records: { get: async () => [{ packageName: 'plugin', source: 'selected', version: '1.0.0' }] },
    })
    const before = await access.snapshot('member', ['plugin'])
    expect(JSON.stringify(before)).not.toContain(key)
    const result = await access.resolve([], { token: 'fictional-member-token', url: 'https://platform.example' }, { username: 'member', installed: ['plugin'] })
    expect(result.environment.PRIVATE_KEY).toBe(key)
    expect(result.snapshot).toEqual(before)
    await store.save('plugin', { environment: [{ name: 'PRIVATE_KEY', value: 'fictional-native-replacement-key' }], entriesYaml: '', entries: {} })
    expect(await access.snapshot('member', ['plugin'])).not.toEqual(before)
  } finally {
    await store.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
