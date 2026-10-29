import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PostgresPluginGrants } from '../src/adapters/postgres-plugin-grants.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { openTestDatabase } from './support/community-application.js'
import { seedPluginParents } from './support/plugin-facts.js'
import { expect, it } from 'vitest'
import { ManagedPluginAdministration } from '../src/use-cases/managed-plugin-administration.js'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'
import type { PreparedPlugin } from '../src/domain/plugin-library.js'
import type { CommunityUserInstance, CommunityRuntimeStatus } from '../src/ports/community-runtime.js'

it('projects startup drift, changes grants without interruption, and restarts only pending running members', async () => {
  const admin: CommunityAccountRecord = {
    username: 'admin',
    spaceId: 'admin-space',
    sessionEpoch: 0,
    admin: true,
    disabled: false,
    groupId: 'admin',
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }
  const member = { ...admin, username: 'member', spaceId: 'member-space', groupId: 'ordinary', admin: false }
  const stopped = { ...member, username: 'stopped', spaceId: 'stopped-space' }
  const groups = [
    { id: 'admin', name: 'Admin', kind: 'admin' as const, isDefault: false, memberCount: 1 },
    { id: 'ordinary', name: 'Ordinary', kind: 'ordinary' as const, isDefault: true, memberCount: 2 },
  ]
  const plugin: PreparedPlugin = {
    packageName: 'private',
    version: '1.0.0',
    integrity: 'hash',
    artifact: 'artifact',
    runtimeRevision: 'revision',
    title: 'Private',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  let granted: readonly string[] = []
  let instance: CommunityUserInstance = {
    userId: 'member',
    origin: 'http://localhost',
    launchUrl: 'http://localhost',
    processId: 1,
    pluginAccessSnapshot: [] as string[],
    managedSnapshot: [] as string[],
    managedFailures: ['private'],
  }
  let accessSnapshot: string[] = []
  const restarted: string[] = []
  const service = new ManagedPluginAdministration(
    {
      get: async username => [admin, member, stopped].find(account => account.username === username),
      list: async () => [admin, member, stopped],
      listGroups: async () => groups,
    },
    {
      list: async () => [
        { ...plugin, stage: 'available', current: plugin, published: false },
        { ...plugin, packageName: 'failed', stage: 'failed', current: null, published: false },
        { ...plugin, packageName: 'old', stage: 'available', current: { ...plugin, runtimeRevision: 'old' }, published: false },
      ],
      remove: async () => {},
      save: async () => {},
    },
    {
      get: async () => granted,
      preinstalls: async () => [],
      configure: async (_id, next) => {
        granted = next
      },
      set: async (_id, next) => {
        granted = next
      },
      remove: async () => {},
      retainGroups: async () => {},
    },
    { effective: async () => (granted.length ? [plugin] : []) },
    { status: (username): CommunityRuntimeStatus => (username === 'member' ? { state: 'ready', instance } : { state: 'stopped' }) },
    {
      restart: async actor => {
        restarted.push(actor.username)
        instance = { ...instance, managedSnapshot: ['private@1.0.0:hash'], managedFailures: [] }
        return instance
      },
    },
    'revision',
    { snapshot: async () => accessSnapshot },
  )
  expect((await service.group(admin, 'ordinary')).pendingMembers).toEqual([])
  expect((await service.save(admin, 'ordinary', ['private'], [], (await service.group(admin, 'ordinary')).revision)).pendingMembers).toEqual(['member'])
  expect(restarted).toEqual([])
  expect((await service.group(admin, 'ordinary')).plugins[0]?.failures).toEqual([{ username: 'member', code: 'plugin-managed-load-failed' }])
  const beforeInspection = (await service.group(admin, 'ordinary')).revision
  Object.assign(instance, { inspection: 'checking', managedSnapshot: ['private@1.0.0:hash'] })
  expect((await service.group(admin, 'ordinary')).plugins[0]).toMatchObject({
    checking: ['member'],
    failures: [{ username: 'member', code: 'plugin-managed-load-failed' }],
  })
  expect((await service.group(admin, 'ordinary')).revision).toBe(beforeInspection)
  Object.assign(instance, { inspection: 'complete' })
  expect((await service.group(admin, 'ordinary')).plugins[0]?.checking).toBeUndefined()
  Object.assign(instance, { managedSnapshot: [] })
  await service.restartAffected(admin, 'ordinary', new URL('http://localhost'))
  expect(restarted).toEqual(['member'])
  expect((await service.group(admin, 'ordinary')).pendingMembers).toEqual([])
  accessSnapshot = ['private:access-new']
  expect((await service.group(admin, 'ordinary')).pendingMembers).toEqual(['member'])
  instance = { ...instance, pluginAccessSnapshot: accessSnapshot }
  expect((await service.group(admin, 'ordinary')).pendingMembers).toEqual([])
  expect((await service.save(admin, 'ordinary', [], [], (await service.group(admin, 'ordinary')).revision)).pendingMembers).toEqual(['member'])
  expect(await service.grantCount('admin')).toBe(0)
  expect((await service.group(admin, 'admin')).plugins.every(row => !row.granted)).toBe(true)
  expect((await service.save(admin, 'admin', ['private'], [], (await service.group(admin, 'admin')).revision)).plugins[0]?.granted).toBe(true)
  expect(await service.grantCount('admin')).toBe(1)
  expect((await service.save(admin, 'admin', [], [], (await service.group(admin, 'admin')).revision)).plugins.every(row => !row.granted)).toBe(true)
  await expect(service.save(member, 'ordinary', [], [], (await service.group(admin, 'ordinary')).revision)).rejects.toThrow(
    expect.objectContaining({ code: 'admin-required' }),
  )
  await expect(service.save(admin, 'ordinary', ['failed'], [], (await service.group(admin, 'ordinary')).revision)).rejects.toThrow(
    expect.objectContaining({ code: 'plugin-grant-invalid' }),
  )
  await expect(service.save(admin, 'ordinary', ['old'], [], (await service.group(admin, 'ordinary')).revision)).rejects.toThrow(
    expect.objectContaining({ code: 'plugin-grant-invalid' }),
  )
  granted = ['old']
  expect(
    (await service.save(admin, 'ordinary', ['old'], [], (await service.group(admin, 'ordinary')).revision)).plugins.find(row => row.packageName === 'old'),
  ).toMatchObject({ granted: true, available: false })
  await expect(service.save(admin, 'ordinary', ['missing'], [], (await service.group(admin, 'ordinary')).revision)).rejects.toThrow(
    expect.objectContaining({ code: 'plugin-grant-invalid' }),
  )
})

it('saves mutually exclusive lists against a stable revision and derives credential hints from current library configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-group-'))
  const database = await openTestDatabase(root)
  try {
    const actor: CommunityAccountRecord = {
      username: 'admin',
      spaceId: 'admin-space',
      sessionEpoch: 0,
      admin: true,
      disabled: false,
      groupId: 'admin',
      email: '',
      createdAt: 0,
      updatedAt: 0,
    }
    const group = await new PostgresCommunityAccountStore(database).createGroup('Team')
    await seedPluginParents(database, ['plugin'])
    const plugin: PreparedPlugin = {
      packageName: 'plugin',
      version: '1.0.0',
      integrity: 'hash',
      artifact: 'artifact',
      runtimeRevision: 'runtime',
      title: 'Plugin',
      description: '',
      bundlePatch: '[]',
      dependencies: {},
    }
    let credential = '',
      incompatible = false
    const store = new PostgresPluginGrants(database)
    const service = new ManagedPluginAdministration(
      { get: async () => actor, list: async () => [actor], listGroups: async () => [group] },
      {
        list: async () => [{ ...plugin, stage: 'available', current: plugin, published: false, ...(incompatible ? { incompatible: true } : {}) }],
        save: async () => {},
        remove: async () => {},
      },
      store,
      { effective: async () => [] },
      { status: () => ({ state: 'stopped' }) },
      {
        restart: async () => {
          throw Error('No restart during configuration')
        },
      },
      'runtime',
      undefined,
      { list: () => [{ name: 'upstream', baseUrl: 'https://example.test', credential, headers: [] }] },
    )
    const current = async () => await service.group(actor, group.id)
    const save = async (controlled: readonly string[], preinstalled: readonly string[], revision?: string) =>
      await service.save(actor, group.id, controlled, preinstalled, revision ?? (await current()).revision)
    const initial = await current()
    expect(initial.revision).toEqual(expect.any(String))
    expect(initial.plugins[0]).toMatchObject({ granted: false, preinstalled: false, hasPlatformCredential: false })
    await save(['plugin'], [])
    await expect(save([], ['plugin'], initial.revision)).rejects.toThrow(expect.objectContaining({ code: 'plugin-impact-changed' }))
    const moved = await save([], ['plugin'])
    expect(moved.plugins[0]).toMatchObject({ granted: false, preinstalled: true })
    await expect(save(['plugin'], ['plugin'])).rejects.toThrow(expect.objectContaining({ code: 'plugin-grant-invalid' }))
    expect((await current()).plugins[0]).toMatchObject({ granted: false, preinstalled: true })
    expect((await save(['plugin'], [])).plugins[0]).toMatchObject({ granted: true, preinstalled: false })
    const beforeCredential = (await current()).revision
    credential = 'shared-fixture'
    expect((await current()).plugins[0]?.hasPlatformCredential).toBe(true)
    await expect(save([], ['plugin'], beforeCredential)).rejects.toThrow(expect.objectContaining({ code: 'plugin-impact-changed' }))
    await expect(save([], ['missing'])).rejects.toThrow(expect.objectContaining({ code: 'plugin-grant-invalid' }))
    incompatible = true
    expect((await save(['plugin'], [])).plugins[0]).toMatchObject({ granted: true, available: false })
    await expect(save([], ['plugin'])).rejects.toThrow(expect.objectContaining({ code: 'plugin-grant-invalid' }))
    expect((await save([], [])).plugins[0]).toMatchObject({ granted: false, preinstalled: false })
  } finally {
    try {
      await database.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
