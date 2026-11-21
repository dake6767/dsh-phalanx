import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { QueryResultRow } from 'pg'
import { PostgresPluginInstallations } from '../src/adapters/postgres-plugin-installations.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { PostgresRuntimeDependencyStore } from '../src/adapters/postgres-runtime-dependencies.js'
import { PostgresRuntimeReferences } from '../src/adapters/postgres-runtime-references.js'
import { runtimeDependencyInput } from '../src/domain/runtime-dependency.js'
import { openTestDatabase } from './support/community-application.js'

it('persists successful deliveries by immutable member space and keeps independent package histories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-installations-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const spaceA = (await accounts.create({ username: 'a', email: '', password: 'password' })).spaceId
    const spaceB = (await accounts.create({ username: 'b', email: '', password: 'password' })).spaceId
    const records = new PostgresPluginInstallations(database)
    await records.save(spaceA, { packageName: 'plugin', source: 'preinstall', version: '1.0.0' })
    await records.save(spaceA, { packageName: 'other', source: 'selected', version: '2.0.0' })
    await records.save(spaceB, { packageName: 'plugin', source: 'selected', version: '3.0.0' })
    const reopened = new PostgresPluginInstallations(database)
    expect(await reopened.get(spaceA)).toEqual([
      { packageName: 'other', source: 'selected', version: '2.0.0' },
      { packageName: 'plugin', source: 'preinstall', version: '1.0.0' },
    ])
    expect(await reopened.get(spaceB)).toEqual([{ packageName: 'plugin', source: 'selected', version: '3.0.0' }])
    expect(await reopened.get('new-space')).toEqual([])
    await reopened.save(spaceA, {
      packageName: 'plugin',
      source: 'selected',
      version: '1.2.0',
      integrity: 'sha512-checked-member-delivery',
      serviceOrigin: 'catalog',
      resourceOrigin: 'catalog',
    })
    expect(await new PostgresPluginInstallations(database).get(spaceA)).toContainEqual({
      packageName: 'plugin',
      source: 'selected',
      version: '1.2.0',
      integrity: 'sha512-checked-member-delivery',
      serviceOrigin: 'catalog',
      resourceOrigin: 'catalog',
    })
    const expected = (await reopened.get(spaceA)).find(row => row.packageName === 'plugin')!
    const history = { chat: { contract: 'contract', applied: null, pending: 'next' } }
    expect(await reopened.replaceServiceSettings(spaceA, expected, history)).toBe(true)
    expect(await reopened.replaceServiceSettings(spaceA, expected, {})).toBe(false)
    expect((await records.get(spaceA)).find(row => row.packageName === 'plugin')?.serviceSettings).toEqual(history)
    expect(await reopened.replaceServiceSettings(spaceB, expected, history)).toBe(false)
    await reopened.resetForSpace(spaceA)
    expect(await reopened.replaceServiceSettings(spaceA, { ...expected, serviceSettings: history }, history)).toBe(false)
    expect(await new PostgresPluginInstallations(database).get(spaceA)).toEqual([
      { packageName: 'other', source: 'selected', version: '2.0.0' },
      { packageName: 'plugin', source: 'selected', version: '1.2.0', integrity: 'sha512-checked-member-delivery' },
    ])
    await reopened.save(spaceA, { packageName: 'preinstalled', source: 'preinstall', version: '1.0.0' })
    await reopened.resetForSpace(spaceA)
    expect((await new PostgresPluginInstallations(database).get(spaceA)).map(row => row.packageName)).toEqual(['other', 'plugin'])
    expect(await new PostgresPluginInstallations(database).get(spaceB)).toEqual([{ packageName: 'plugin', source: 'selected', version: '3.0.0' }])
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('retains concurrent successful deliveries for different member spaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-installations-concurrent-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const spaceA = (await accounts.create({ username: 'a', email: '', password: 'password' })).spaceId
    const spaceB = (await accounts.create({ username: 'b', email: '', password: 'password' })).spaceId
    const records = new PostgresPluginInstallations(database)
    await Promise.all([
      records.save(spaceA, { packageName: 'one', source: 'selected', version: '1.0.0' }),
      records.save(spaceB, { packageName: 'two', source: 'preinstall', version: '2.0.0' }),
    ])
    const reopened = new PostgresPluginInstallations(database)
    expect(await reopened.get(spaceA)).toEqual([{ packageName: 'one', source: 'selected', version: '1.0.0' }])
    expect(await reopened.get(spaceB)).toEqual([{ packageName: 'two', source: 'preinstall', version: '2.0.0' }])
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('retains an exact delivered browser after its catalog plugin retires and releases it after member uninstall', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-browser-installations-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const { spaceId } = await accounts.create({ username: 'member', email: '', password: 'password' })
    const records = new PostgresPluginInstallations(database)
    const library = new PostgresPluginLibraryStore(database)
    const resources = new PostgresRuntimeDependencyStore(database)
    const references = new PostgresRuntimeReferences(database)
    const resource = runtimeDependencyInput({ name: 'chrome', type: 'resource', prepareCommand: 'prepare-browser' })
    await resources.save({ ...resource, source: 'suite-catalog', stage: 'preparing', updatedAt: 1, log: '', checks: [] })
    const delivery = {
      packageName: 'design',
      version: '1.0.0',
      integrity: 'sha512-example',
      source: 'selected' as const,
      resourceOrigin: 'suite:design',
    }
    const browser = {
      kind: 'playwright-browser' as const,
      dependency: 'chrome',
      runtimeDependency: 'chrome',
      path: 'browser',
      version: '1.0.0',
      contentHash: 'a'.repeat(64),
      playwrightVersion: '1.64.1',
      chromiumBuild: '1248',
      directories: ['chromium-1248'],
    }
    await library.save({
      packageName: delivery.packageName,
      version: delivery.version,
      source: { kind: 'upload' },
      suiteOrigin: delivery.resourceOrigin,
      stage: 'available',
      published: true,
      runtimeDependencies: ['chrome'],
      suiteResourceBindings: [browser],
      current: {
        packageName: delivery.packageName,
        version: delivery.version,
        integrity: delivery.integrity,
        title: 'Design',
        runtimeRevision: 'runtime',
        artifact: '/archive',
        description: '',
        bundlePatch: '',
        dependencies: {},
      },
    })
    await records.save(spaceId, { ...delivery, integrity: 'different-archive' })
    expect(await references.browserConsumers('chrome')).toEqual([{ name: 'Design', build: '1248', playwrightVersion: '1.64.1' }])
    const reservation = await records.reserveBrowserDelivery(spaceId, delivery.packageName, delivery, 'installing-generation')
    expect(reservation).toBeDefined()
    await library.remove(delivery.packageName)
    expect(await references.list('chrome')).toEqual([{ kind: 'member-plugin', name: 'design' }])
    expect(await references.retainedBrowserBindings()).toEqual([browser])
    await expect(resources.remove('chrome')).rejects.toThrow()
    const { source, ...resourceDelivery } = delivery
    void source
    const active = { ...resourceDelivery, browserBindings: [browser] }
    expect((await records.nativeResourceSnapshot(spaceId)).recovering).toEqual([active])
    expect(await records.isBrowserArchiveReserved(spaceId, delivery.integrity)).toBe(true)
    expect(await references.browserConsumers('chrome')).toEqual([{ name: 'Design', build: '1248', playwrightVersion: '1.64.1' }])
    expect(await records.browserDeliveries(spaceId, 'replacement-generation')).toEqual([])
    await records.deferBrowserDelivery(reservation!)
    expect(await records.browserDeliveries(spaceId, 'installing-generation')).toEqual([])
    await records.releaseMissingBrowserDeliveries(spaceId, [reservation!], 'installing-generation')
    expect(await records.browserDeliveries(spaceId, 'replacement-generation')).toEqual([
      { packageName: 'design', version: delivery.version, integrity: delivery.integrity, revision: reservation },
    ])
    let snapshotStatements = 0
    const duringTransfer = new PostgresPluginInstallations({
      cipher: database.cipher(),
      sql: {
        async query<Row extends QueryResultRow>(statement: string, values?: readonly unknown[]): Promise<Row[]> {
          const rows = await database.query<Row>(statement, values)
          if (++snapshotStatements === 1) await records.save(spaceId, delivery, reservation)
          return rows
        },
      },
    })
    expect(await duringTransfer.nativeResourceSnapshot(spaceId)).toEqual({
      delivered: [{ ...resourceDelivery, integrity: 'different-archive' }],
      recovering: [active],
    })
    expect(snapshotStatements).toBe(1)
    expect(await records.nativeResourceSnapshot(spaceId)).toEqual({ delivered: [active], recovering: [] })
    await records.releaseBrowserDelivery(reservation!)
    expect(await records.get(spaceId)).toEqual([{ ...delivery, browserBindings: [browser] }])
    expect(await references.browserConsumers('chrome')).toEqual([{ name: 'Design', build: '1248', playwrightVersion: '1.64.1', memberCopies: 1 }])
    const { resourceOrigin, ...uninstalled } = delivery
    void resourceOrigin
    await records.save(spaceId, uninstalled)
    expect(await references.list('chrome')).toEqual([])
    expect(await references.retainedBrowserBindings()).toEqual([])
    await resources.remove('chrome')
    expect(await records.get(spaceId)).toEqual([uninstalled])
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
