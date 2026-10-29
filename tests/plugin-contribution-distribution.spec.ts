import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PostgresPluginGrants } from '../src/adapters/postgres-plugin-grants.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { openTestDatabase } from './support/community-application.js'
import { seedPluginParents } from './support/plugin-facts.js'
import { expect, it } from 'vitest'
import { PluginContributionDistribution } from '../src/use-cases/plugin-contribution-distribution.js'
import { ManagedPluginAdministration } from '../src/use-cases/managed-plugin-administration.js'
import { PluginMarket } from '../src/use-cases/plugin-market.js'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'
import type { MemberContribution } from '../src/domain/member-contribution.js'
it('checks group impact before adoption and replays publication and grants once while preserving later administrator choices', async () => {
  const actor = {
    username: 'admin',
    spaceId: 'admin-space',
    sessionEpoch: 0,
    admin: true,
    disabled: false,
    email: '',
    groupId: 'admin',
    createdAt: 0,
    updatedAt: 0,
  }
  let groups = [{ id: 'ordinary', name: 'Team', kind: 'ordinary' as const, isDefault: true, memberCount: 0 }],
    granted: readonly string[] = [],
    preinstalled: readonly string[] = []
  const accounts = { get: async () => actor, list: async () => [actor], listGroups: async () => groups }
  const prepared = {
    packageName: 'plugin',
    version: '1.0.0',
    integrity: 'pinned',
    artifact: 'artifact',
    runtimeRevision: 'runtime',
    title: 'Plugin',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  let plugin: LibraryPlugin = { ...prepared, current: prepared, stage: 'available', published: false }
  const library = {
    list: async () => [plugin],
    save: async (row: LibraryPlugin) => {
      plugin = row
    },
    remove: async () => {},
  }
  const managed = new ManagedPluginAdministration(
    accounts,
    library,
    {
      get: async () => granted,
      preinstalls: async () => preinstalled,
      configure: async (_id, next, native) => {
        granted = next
        preinstalled = native
      },
      set: async (_id, next) => {
        granted = next
      },
      remove: async () => {},
      retainGroups: async () => {},
    },
    { effective: async () => [] },
    { status: () => ({ state: 'stopped' }) },
    { restart: async () => ({ userId: 'admin', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1 }) },
    'runtime',
  )
  const market = new PluginMarket(
    accounts,
    library,
    { list: async () => [] },
    { ensure: async () => ({ userId: 'admin', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1 }) },
    { get: async () => [], set: async () => {}, members: async () => [], removePackage: async () => {}, retainPackages: async () => {} },
    { effective: async () => [], granted: async () => [] },
    'runtime',
  )
  const service = new PluginContributionDistribution(library, managed, market)
  const row: MemberContribution = {
    kind: 'plugin',
    id: 'contribution',
    revision: 'revision',
    name: 'plugin',
    description: '',
    hash: 'fingerprint',
    markdown: '',
    files: [],
    contributor: actor,
    submittedAt: 1,
    updatedAt: 1,
    status: 'pending',
    plugin: { candidate: { packageName: 'plugin', version: '1.0.0' }, prepared },
    declaration: { purpose: 'Share plugin' },
  }
  const view = await service.groups(actor, row.name),
    setup = { published: true, credentialSharingConfirmed: true, groups: view.map(group => ({ id: group.group.id, revision: group.revision })) }
  await service.validate(actor, row.name, setup)
  granted = ['other']
  await expect(service.validate(actor, row.name, setup)).rejects.toThrow(expect.objectContaining({ code: 'plugin-impact-changed' }))
  granted = []
  preinstalled = ['plugin']
  await expect(service.validate(actor, row.name, setup)).rejects.toThrow(expect.objectContaining({ code: 'plugin-impact-changed' }))
  expect((await service.groups(actor, row.name))[0]).toMatchObject({ preinstalled: true })
  const conflicting = { groups: (await service.groups(actor, row.name)).map(group => ({ id: group.group.id, revision: group.revision })) }
  await expect(service.validate(actor, row.name, conflicting)).rejects.toThrow(expect.objectContaining({ code: 'plugin-grant-invalid' }))
  expect(await managed.adoptContribution('plugin', conflicting.groups)).toHaveLength(1)
  expect(granted).toEqual([])
  expect(preinstalled).toEqual(['plugin'])
  preinstalled = []
  expect(await service.apply(row, setup)).toEqual([])
  expect(granted).toEqual(['plugin'])
  expect(plugin.published).toBe(true)
  granted = []
  plugin = { ...plugin, published: false }
  expect(await service.apply(row, setup)).toEqual([])
  expect(granted).toEqual([])
  expect(plugin.published).toBe(false)
  groups = []
  expect(await service.apply({ ...row, id: 'another', revision: 'next' }, setup)).toEqual(['A selected group was removed; its plugin grant was not applied.'])
})

it('preserves later revoke and unpublish if final orchestration receipt fails after both effects were committed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-distribution-'))
  const database = await openTestDatabase(root)
  try {
    const actor = {
      username: 'admin',
      spaceId: 'space',
      sessionEpoch: 0,
      admin: true,
      disabled: false,
      email: '',
      groupId: 'admins',
      createdAt: 0,
      updatedAt: 0,
    }
    const group = await new PostgresCommunityAccountStore(database).createGroup('Team')
    const groups = [group]
    await seedPluginParents(database, ['plugin'])
    const accounts = { get: async () => actor, list: async () => [actor], listGroups: async () => groups }
    const prepared = {
      packageName: 'plugin',
      version: '1.0.0',
      integrity: 'pinned',
      artifact: 'artifact',
      runtimeRevision: 'runtime',
      title: '',
      description: '',
      bundlePatch: '[]',
      dependencies: {},
    }
    let plugin: LibraryPlugin = { ...prepared, current: prepared, stage: 'available', published: false },
      fail = true
    const library = {
      list: async () => [plugin],
      save: async (row: LibraryPlugin) => {
        if (row.contributionDistributionReceipt && fail) {
          fail = false
          throw Error('interrupted final receipt')
        }
        plugin = structuredClone(row)
      },
      remove: async () => {},
    }
    let grants = new PostgresPluginGrants(database)
    const managed = () =>
      new ManagedPluginAdministration(
        accounts,
        library,
        grants,
        { effective: async () => [] },
        { status: () => ({ state: 'stopped' }) },
        { restart: async () => ({ userId: 'admin', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1 }) },
        'runtime',
      )
    const market = new PluginMarket(
      accounts,
      library,
      { list: async () => [] },
      { ensure: async () => ({ userId: 'admin', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1 }) },
      { get: async () => [], set: async () => {}, members: async () => [], removePackage: async () => {}, retainPackages: async () => {} },
      { effective: async () => [], granted: async () => [] },
      'runtime',
    )
    const row: MemberContribution = {
      kind: 'plugin',
      id: 'id',
      revision: 'revision',
      name: 'plugin',
      description: '',
      hash: 'fingerprint',
      markdown: '',
      files: [],
      contributor: actor,
      submittedAt: 1,
      updatedAt: 1,
      status: 'pending',
      plugin: { candidate: prepared, prepared },
      declaration: { purpose: 'Share' },
    }
    const setup = { published: true, credentialSharingConfirmed: true, groups: [{ id: group.id, revision: 'review' }] }
    await expect(new PluginContributionDistribution(library, managed(), market).apply(row, setup)).rejects.toThrow('interrupted final receipt')
    expect(await grants.get(group.id)).toEqual(['plugin'])
    expect(plugin.published).toBe(true)
    await grants.set(group.id, [])
    await market.publish(actor, 'plugin', false, { confirmed: true, selectedMembers: 0 })
    grants = new PostgresPluginGrants(database)
    expect(await new PluginContributionDistribution(library, managed(), market).apply(row, setup)).toEqual([])
    expect(await grants.get(group.id)).toEqual([])
    expect(plugin.published).toBe(false)
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('finishes with a durable sharing warning if credentials appear after confirmation, and does not publish on replay', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0, admin: true, disabled: false, email: '', groupId: 'admin', createdAt: 0, updatedAt: 0 }
  const accounts = { get: async () => actor, list: async () => [actor] }
  const prepared = {
    packageName: 'plugin',
    version: '1.0.0',
    integrity: 'pinned',
    artifact: 'artifact',
    runtimeRevision: 'runtime',
    title: '',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  let plugin: LibraryPlugin = { ...prepared, current: prepared, stage: 'available', published: false }
  const library = {
    list: async () => [plugin],
    save: async (row: LibraryPlugin) => {
      plugin = structuredClone(row)
    },
    remove: async () => {},
  }
  let credential = ''
  const market = new PluginMarket(
    accounts,
    library,
    { list: async () => [] },
    { ensure: async () => ({ userId: 'admin', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1 }) },
    { get: async () => [], set: async () => {}, members: async () => [], removePackage: async () => {}, retainPackages: async () => {} },
    { effective: async () => [], granted: async () => [] },
    'runtime',
    undefined,
    { list: () => [{ name: 'search', baseUrl: 'https://provider.example', headers: [], credential }] },
  )
  // Confirmation was valid without sharing when promotion yielded. Another administrator adds a credential.
  credential = 'new-platform-fixture-secret'
  const receipt = { id: 'contribution', revision: 'revision' },
    warnings = await market.publishContribution('plugin', false, receipt)
  expect(warnings).toHaveLength(1)
  expect(plugin.published).toBe(false)
  credential = ''
  expect(await market.publishContribution('plugin', false, receipt)).toEqual(warnings)
  expect(plugin.published).toBe(false)
})
