import { PluginUpstreamAccess } from '../src/use-cases/plugin-upstream-access.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { PostgresPluginAccessStore } from '../src/adapters/postgres-plugin-access-store.js'
import { PostgresPluginGrants } from '../src/adapters/postgres-plugin-grants.js'
import { PostgresPluginInstallations } from '../src/adapters/postgres-plugin-installations.js'
import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { PostgresPluginSelections } from '../src/adapters/postgres-plugin-selections.js'
import { PostgresPluginUpstreams } from '../src/adapters/postgres-plugin-upstreams.js'
import { PostgresUnitOfWork } from '../src/adapters/postgres-unit-of-work.js'
import { openTestDatabase } from './support/community-application.js'

it('rolls back plugin removal across relations and cascades only facts owned by that plugin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-domain-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const member = await accounts.create({ username: 'member', email: '', password: 'password' })
    const library = new PostgresPluginLibraryStore(database)
    const grants = new PostgresPluginGrants(database)
    const selections = new PostgresPluginSelections(database)
    const local = new PostgresPluginSelections(database, 'local')
    const history = new PostgresPluginInstallations(database)
    await library.save({
      packageName: 'plugin',
      version: '1.0.0',
      stage: 'failed',
      current: null,
      published: false,
      upload: { archive: 'uploads/current.tgz', integrity: 'sha512-current' },
      replacement: {
        packageName: 'plugin',
        version: '2.0.0',
        stage: 'failed',
        prepared: null,
        upload: { archive: 'uploads/replacement.tgz', integrity: 'sha512-replacement' },
      },
    })
    const originalLibrary = await library.list()
    expect(originalLibrary[0]).toMatchObject({
      upload: { archive: 'uploads/current.tgz', integrity: 'sha512-current' },
      replacement: { upload: { archive: 'uploads/replacement.tgz', integrity: 'sha512-replacement' } },
    })
    const preinstalledGroup = await accounts.createGroup('Preinstalled')
    await grants.configure(preinstalledGroup.id, [], ['plugin'])
    await grants.grantContribution('default', 'plugin', { id: 'contribution', revision: 'one' })
    await selections.set(member.spaceId, ['plugin'])
    await local.set(member.spaceId, ['plugin'])
    await history.save(member.spaceId, { packageName: 'plugin', version: '1.0.0', source: 'preinstall' })
    const access = new PostgresPluginAccessStore(database),
      upstreams = new PostgresPluginUpstreams(database)
    await access.initialize()
    await upstreams.initialize()
    await access.save('plugin', { environment: [{ name: 'KEY', value: 'fictional-domain-key' }], entriesYaml: '', entries: {} })
    await access.applySuite('plugin', 'catalog-task', { environment: [], entriesYaml: '', entries: {} })
    await upstreams.save('plugin', [{ name: 'search', baseUrl: 'https://example.test', credential: 'fictional-domain-credential', headers: [] }])
    const beforeAccess = await access.get('plugin'),
      beforeCheckpoint = await access.suiteCheckpoint('plugin'),
      beforeUpstreams = await upstreams.list('plugin')
    const generation = library.authorizationRevision()
    const work = new PostgresUnitOfWork(database, { library: tx => new PostgresPluginLibraryStore(tx) })
    await expect(
      work.run(async repositories => {
        await repositories.library.remove('plugin')
        throw Error('injected failure')
      }),
    ).rejects.toThrow('injected failure')
    expect(await library.list()).toEqual(originalLibrary)
    expect(library.authorizationRevision()).toBe(generation)
    expect(await access.get('plugin')).toEqual(beforeAccess)
    expect(await access.suiteCheckpoint('plugin')).toEqual(beforeCheckpoint)
    expect(await upstreams.list('plugin')).toEqual(beforeUpstreams)
    expect(await grants.get('default')).toEqual(['plugin'])
    expect(await grants.preinstalls(preinstalledGroup.id)).toEqual(['plugin'])
    expect(await selections.get(member.spaceId)).toEqual(['plugin'])
    expect(await local.get(member.spaceId)).toEqual(['plugin'])
    const beforeRemoval = library.authorizationRevision()
    await work.run(repositories => repositories.library.remove('plugin'))
    expect(await library.list()).toEqual([])
    expect(library.authorizationRevision()).not.toBe(beforeRemoval)
    expect(await access.get('plugin')).toBeUndefined()
    expect(await access.suiteCheckpoint('plugin')).toBeUndefined()
    expect(await upstreams.list('plugin')).toEqual([])
    expect(await grants.get('default')).toEqual([])
    expect(await grants.preinstalls(preinstalledGroup.id)).toEqual([])
    expect(await grants.contributionReceipt('default', 'plugin')).toBeUndefined()
    expect(await selections.get(member.spaceId)).toEqual([])
    expect(await local.get(member.spaceId)).toEqual([])
    expect(await history.get(member.spaceId)).toEqual([{ packageName: 'plugin', version: '1.0.0', source: 'preinstall' }])
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('cascades group and account facts while retaining a replacement delivery until the space is deleted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-cascade-')),
    database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database),
      library = new PostgresPluginLibraryStore(database),
      grants = new PostgresPluginGrants(database),
      selections = new PostgresPluginSelections(database),
      local = new PostgresPluginSelections(database, 'local'),
      history = new PostgresPluginInstallations(database)
    const member = await accounts.create({ username: 'member', email: '', password: 'password' }),
      group = await accounts.createGroup('Temporary')
    await library.save({ packageName: 'plugin', version: '1.0.0', stage: 'failed', current: null, published: false })
    await library.save({ packageName: 'another', version: '1.0.0', stage: 'failed', current: null, published: false })
    await grants.configure(group.id, [], ['another'])
    await grants.grantContribution(group.id, 'plugin', { id: 'contribution', revision: 'one' })
    await selections.set(member.spaceId, ['plugin'])
    await local.set(member.spaceId, ['plugin'])
    await history.save(member.spaceId, { packageName: 'plugin', version: '1.0.0', source: 'preinstall' })
    await history.save(member.spaceId, { packageName: 'plugin', version: '1.2.0', source: 'selected' })
    await history.clearPreinstalls(member.spaceId)
    expect(await history.get(member.spaceId)).toEqual([{ packageName: 'plugin', version: '1.2.0', source: 'selected' }])
    const beforeGroupRemoval = grants.authorizationRevision()
    await accounts.deleteGroup(group.id)
    expect(grants.authorizationRevision()).not.toBe(beforeGroupRemoval)
    expect(await grants.preinstalls(group.id)).toEqual([])
    expect(await grants.get(group.id)).toEqual([])
    expect(await grants.contributionReceipt(group.id, 'plugin')).toBeUndefined()
    const beforeAccountRemoval = local.authorizationRevision()
    await accounts.delete('member')
    expect(local.authorizationRevision()).not.toBe(beforeAccountRemoval)
    expect(await selections.get(member.spaceId)).toEqual([])
    expect(await local.get(member.spaceId)).toEqual([])
    expect(await history.get(member.spaceId)).toEqual([])
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses an old library row after another writer has changed the same package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-row-revision-')),
    database = await openTestDatabase(root)
  try {
    const library = new PostgresPluginLibraryStore(database)
    await library.save({ packageName: 'example', version: '1.0.0', stage: 'failed', current: null, published: false })
    const stale = (await library.list())[0]!
    await library.save({ ...stale, published: true })
    await expect(library.save({ ...stale, published: false })).rejects.toMatchObject({ code: 'platform-configuration-conflict' })
    expect((await library.list())[0]?.published).toBe(true)
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('admits unchanged plugin credentials when unrelated usage commits during the member lookup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-admission-usage-')),
    database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database),
      library = new PostgresPluginLibraryStore(database),
      grants = new PostgresPluginGrants(database),
      upstreams = new PostgresPluginUpstreams(database)
    const member = await accounts.create({ username: 'member', email: '', password: 'password' })
    await library.save({
      packageName: 'plugin',
      version: '1.0.0',
      stage: 'available',
      published: true,
      current: {
        packageName: 'plugin',
        version: '1.0.0',
        runtimeRevision: 'rev',
        integrity: 'fixture',
        artifact: 'artifacts/fixture',
        title: 'Plugin',
        description: '',
        bundlePatch: '',
        dependencies: {},
      },
    })
    await upstreams.initialize()
    await upstreams.save('plugin', [{ name: 'search', baseUrl: 'https://example.test', credential: 'fictional-domain-credential', headers: [] }])
    let recordUsage = true
    const gate = new PluginUpstreamAccess(
      {
        get: async username => {
          if (recordUsage) {
            recordUsage = false
            await database.query('UPDATE dsh_phalanx.usage_settings SET retention_days=retention_days+1 WHERE id=1')
          }
          return accounts.get(username)
        },
        listGroups: accounts.listGroups.bind(accounts),
        withCurrentState: accounts.withCurrentState.bind(accounts),
      },
      { resolve: token => (token === 'member-token' ? { username: member.username, spaceId: member.spaceId } : undefined) },
      library,
      grants,
      upstreams,
      'rev',
    )
    expect(await gate.authorize('plugin', 'search', { authorization: 'Bearer member-token' })).toMatchObject({
      username: 'member',
      upstream: { credential: 'fictional-domain-credential' },
    })
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('retains a contribution receipt when an administrator later revokes its grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-receipt-')),
    database = await openTestDatabase(root)
  try {
    const library = new PostgresPluginLibraryStore(database),
      grants = new PostgresPluginGrants(database)
    await library.save({ packageName: 'plugin', version: '1.0.0', stage: 'failed', current: null, published: false })
    await grants.grantContribution('default', 'plugin', { id: 'contribution', revision: 'one' })
    await grants.set('default', [])
    expect(await grants.get('default')).toEqual([])
    expect(await grants.contributionReceipt('default', 'plugin')).toEqual({ id: 'contribution', revision: 'one' })
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('commits an unrelated plugin while another package transaction still owns its library and access changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-independent-units-')),
    database = await openTestDatabase(root)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    began = new Promise<void>(resolve => {
      entered = resolve
    })
  const work = new PostgresUnitOfWork(database, {
    library: tx => new PostgresPluginLibraryStore(tx),
    access: tx => new PostgresPluginAccessStore(tx),
  })
  const library = new PostgresPluginLibraryStore(database)
  let first: Promise<void> | undefined, second: Promise<void> | undefined
  try {
    for (const packageName of ['first-plugin', 'second-plugin'])
      await library.save({ packageName, version: '1.0.0', stage: 'failed', current: null, published: false })
    const access = new PostgresPluginAccessStore(database)
    await access.initialize()
    for (const name of ['first-plugin', 'second-plugin']) await access.save(name, { environment: [], entriesYaml: '', entries: {} })
    const update = async (rows: { library: PostgresPluginLibraryStore; access: PostgresPluginAccessStore }, name: string) => {
      const original = (await rows.library.list()).find(row => row.packageName === name)!
      await rows.access.list()
      await rows.library.save({ ...original, published: true })
      await rows.access.save(name, { environment: [{ name: 'KEY', value: 'fictional-' + name }], entriesYaml: '', entries: {} })
    }
    first = work.run(async rows => {
      await update(rows, 'first-plugin')
      entered()
      await gate
    })
    await began
    let finished = false
    second = work
      .run(async rows => {
        await update(rows, 'second-plugin')
      })
      .then(() => {
        finished = true
      })
    try {
      await expect.poll(() => finished, { timeout: 4000 }).toBe(true)
    } finally {
      release()
      await Promise.allSettled([first, second])
    }
    await Promise.all([first, second])
    expect((await library.list()).map(row => [row.packageName, row.published])).toEqual([
      ['first-plugin', true],
      ['second-plugin', true],
    ])
  } finally {
    release?.()
    await Promise.allSettled([first, second].filter((value): value is Promise<void> => !!value))
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses an adoption planned for an absent plugin after another writer creates that package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-create-cas-')),
    database = await openTestDatabase(root),
    library = new PostgresPluginLibraryStore(database)
  try {
    const plan = { packageName: 'new-plugin', version: '1.0.0', stage: 'failed' as const, current: null, published: false }
    await library.save({ ...plan, version: '2.0.0' })
    await expect(library.save(plan, 'none')).rejects.toMatchObject({ code: 'platform-configuration-conflict' })
    expect((await library.list())[0]).toMatchObject({ version: '2.0.0' })
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
