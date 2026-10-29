import { createHash } from 'node:crypto'
import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { PostgresPluginUpstreams } from '../src/adapters/postgres-plugin-upstreams.js'
import { PostgresPluginGrants } from '../src/adapters/postgres-plugin-grants.js'
import { PostgresPluginSelections } from '../src/adapters/postgres-plugin-selections.js'
import { PluginLibraryMembership } from '../src/use-cases/plugin-library-membership.js'
import { SuiteCatalog } from '../src/use-cases/suite-catalog.js'
import { createSuiteStorage } from '../src/composition/suite-storage.js'
import { postgresSuiteService } from './fixtures/postgres-suite-service.js'
import { fixtureGallery } from './fixtures/suite-gallery.js'
import { dropCreatedDatabase } from './support/postgres.js'
import { afterEach, expect, it, vi } from 'vitest'
import { YamlPluginAccessSyntax } from '../src/adapters/plugin-access-syntax.js'
import { PostgresPluginAccessStore } from '../src/adapters/postgres-plugin-access-store.js'
import type { LibraryPlugin, PreparedPlugin } from '../src/domain/plugin-library.js'
import type { SuiteCatalogEntry, SuiteCatalogPluginItem, SuiteCatalogSuiteEntry } from '../src/domain/suite-catalog.js'
import { PluginAccessAdministration } from '../src/use-cases/plugin-access-administration.js'
import { PluginLibrary } from '../src/use-cases/plugin-library.js'
import { SuitePlugins } from '../src/use-cases/suite-plugins.js'
import { text } from './fixtures/suite-catalog.js'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of disposers.splice(0).reverse()) await close()
})
const integrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64')
const item = (version = '1.0.0'): SuiteCatalogPluginItem => ({
  kind: 'plugin',
  packageName: '@fixture/editor',
  version,
  integrity,
  runtimeDependencies: [],
  catalogDependencies: [],
  access: { environment: [{ name: 'EDITOR_MODE', value: version }], entriesYaml: '' },
})
const preset = (version = '1.0.0'): SuiteCatalogSuiteEntry => ({
  category: 'plugin',
  id: 'fixture-suite',
  version,
  title: text,
  description: text,
  identity: text,
  source: text,
  dependencies: [],
  items: [item(version)],
})
async function setup() {
  const f = await postgresSuiteService(),
    database = f.database,
    store = new PostgresPluginLibraryStore(database),
    storage = createSuiteStorage(database),
    accessStore = new PostgresPluginAccessStore(database),
    upstreams = new PostgresPluginUpstreams(database),
    grants = new PostgresPluginGrants(database),
    choices = new PostgresPluginSelections(database)
  const databaseName = (await database.query<{ name: string }>('SELECT current_database() AS name'))[0]!.name
  await accessStore.initialize()
  await upstreams.initialize()
  const access = new PluginAccessAdministration(f.accounts, store, accessStore, upstreams, new YamlPluginAccessSyntax())
  let wait: Promise<void> | undefined,
    corrupt = false
  const prepared = (version: string): PreparedPlugin => ({
    packageName: '@fixture/editor',
    version,
    integrity,
    artifact: 'fixture',
    runtimeRevision: 'rev',
    title: 'Editor',
    description: '',
    dependencies: {},
    bundlePatch: '- insert:\n  - id: main\n    name: editor\n',
  })
  const library = new PluginLibrary(
    f.accounts,
    store,
    {
      prepare: async input => {
        await wait
        return { ...prepared(input.version), ...(corrupt ? { integrity: 'wrong' } : {}) }
      },
    },
    undefined,
    new PluginLibraryMembership(f.accounts, grants, choices),
    undefined,
    { access: accessStore, upstreams },
  )
  const port = new SuitePlugins(library, access)
  let entries: readonly SuiteCatalogEntry[] = [preset()]
  const gallery = { ...fixtureGallery(entries), entries: () => entries }
  const suites = new SuiteCatalog(f.accounts, gallery, storage, f.dependencies, { now: () => 1 }, 'amd64', f.library, f.packs, f.execution, port, {
    syntax: new YamlPluginAccessSyntax(),
  })
  const state = async () => ({ installs: (await storage.installs.list()).map(row => row.record) })
  const group = (await f.accounts.listGroups()).find(row => row.kind === 'ordinary')!,
    member = (await f.accounts.list()).find(row => !row.admin)!
  disposers.push(async () => {
    try {
      await suites.stop()
      await library.stop()
      await accessStore.close()
      await upstreams.close()
    } finally {
      await f.close()
      dropCreatedDatabase(databaseName)
    }
  })
  return {
    ...f,
    suites,
    database,
    storage,
    state,
    group,
    member,
    grants,
    choices,
    rows: {
      get: async (name: string) => (await store.list()).find(row => row.packageName === name),
      set: async (_name: string, row: LibraryPlugin) => store.save(row),
      count: async () => (await store.list()).length,
    },
    dependencyRows: {
      get: async (name: string) => (await f.runtime.store.list()).find(row => row.name === name),
      set: async (_name: string, row: import('../src/domain/runtime-dependency.js').RuntimeDependency) => f.runtime.store.save(row),
      has: async (name: string) => (await f.runtime.store.list()).some(row => row.name === name),
    },
    access,
    accessStore,
    library,
    port,
    prepared,
    runtimeHooks: {
      get collect() {
        return f.hooks.beforeCollect
      },
      set collect(value: ((retained: readonly string[]) => Promise<void>) | undefined) {
        if (value) f.hooks.beforeCollect = value
        else delete f.hooks.beforeCollect
      },
    },
    async grant() {
      await grants.configure(group.id, ['@fixture/editor'], [])
      await choices.set(member.spaceId, ['@fixture/editor'])
    },
    async settled(status: 'installed' | 'failed') {
      await expect.poll(async () => (await f.record())?.status).toBe(status)
    },
    upgrade(next: readonly SuiteCatalogEntry[]) {
      entries = next
    },
    block() {
      let release!: () => void
      wait = new Promise<void>(resolve => {
        release = resolve
      })
      return release
    },
    corrupt() {
      corrupt = true
    },
    async reject(table: string, operation: 'INSERT' | 'UPDATE' | 'DELETE' = 'UPDATE') {
      await database.query(`CREATE TABLE dsh_phalanx.reject_plugin_parent(id integer PRIMARY KEY);
        CREATE TABLE dsh_phalanx.reject_plugin_child(id integer REFERENCES dsh_phalanx.reject_plugin_parent DEFERRABLE INITIALLY DEFERRED);
        CREATE FUNCTION dsh_phalanx.reject_plugin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dsh_phalanx.reject_plugin_child VALUES(1); RETURN NULL; END $$;
        CREATE TRIGGER reject_plugin AFTER ${operation} ON dsh_phalanx.${table} FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_plugin();`)
    },
    async accept(table: string) {
      await database.query(`DROP TRIGGER reject_plugin ON dsh_phalanx.${table}`)
    },
  }
}
const request = { id: 'fixture-suite', requestId: 'request-plugin-0000001' }
it('installs one owned plugin with access settings, deduplicates requests and supports uninstall', async () => {
  const f = await setup()
  await f.suites.install(f.actor, request)
  await f.settled('installed')
  expect(await f.library.list(f.actor)).toMatchObject([{ packageName: '@fixture/editor', currentVersion: '1.0.0' }])
  expect((await f.access.view(f.actor, '@fixture/editor')).environment).toEqual([{ name: 'EDITOR_MODE', configured: true, last4: '.0.0' }])
  expect((await f.suites.install(f.actor, request)).status).toBe('installed')
  await expect(f.library.add(f.actor, { packageName: '@fixture/editor', version: '1.0.0' })).rejects.toThrow()
  await f.grant()
  expect((await f.suites.uninstallPreview(f.actor, request.id)).impact).toMatchObject([{ groups: [{ id: f.group.id }], selectedMembers: 1 }])
  await f.suites.uninstall(f.actor, request.id)
  await expect.poll(async () => (await f.state()).installs.length).toBe(0)
  expect(await f.rows.count()).toBe(0)
  expect(await f.grants.get(f.group.id)).toEqual([])
  expect(await f.choices.get(f.member.spaceId)).toEqual([])
})
it('requires replacement confirmation and keeps publication and grants by replacing in place', async () => {
  const f = await setup()
  await f.rows.set('@fixture/editor', { packageName: '@fixture/editor', version: '0.9.0', current: f.prepared('0.9.0'), stage: 'available', published: true })
  const preview = await f.suites.installPreview(f.actor, request.id)
  expect(preview.replacements).toMatchObject([{ kind: 'plugin', name: '@fixture/editor', revision: expect.any(String) }])
  await expect(f.suites.install(f.actor, request)).rejects.toThrow()
  await f.suites.install(f.actor, { ...request, replace: preview.replacements })
  await f.settled('installed')
  expect(await f.rows.get('@fixture/editor')).toMatchObject({ published: true, version: '1.0.0' })
  expect(await f.grants.get(f.group.id)).toEqual([])
})
it('keeps a failed integrity check from changing the manual plugin or its configuration', async () => {
  const f = await setup()
  f.corrupt()
  const original: LibraryPlugin = { packageName: '@fixture/editor', version: '0.9.0', current: f.prepared('0.9.0'), stage: 'available', published: true }
  await f.rows.set('@fixture/editor', original)
  const originalStored = await f.rows.get('@fixture/editor')
  await f.access.save(f.actor, '@fixture/editor', { environment: [{ name: 'CUSTOM_MODE', value: 'manual' }], entriesYaml: '' })
  const before = await f.accessStore.get('@fixture/editor')
  await f.suites.install(f.actor, { ...request, replace: (await f.suites.installPreview(f.actor, request.id)).replacements })
  await f.settled('failed')
  expect(await f.rows.get('@fixture/editor')).toEqual(originalStored)
  expect(await f.accessStore.get('@fixture/editor')).toEqual(before)
})
it('reserves a package before preparation against another entry and manual additions', async () => {
  const f = await setup(),
    release = f.block()
  const other = { ...preset(), id: 'other' }
  f.upgrade([preset(), other])
  await f.suites.install(f.actor, request)
  await expect(f.suites.install(f.actor, { id: 'other', requestId: 'request-plugin-0000002' })).rejects.toThrow()
  await expect(f.library.add(f.actor, { packageName: '@fixture/editor', version: '1.0.0' })).rejects.toThrow()
  release()
  await f.settled('installed')
})
it('updates the package and template while preserving an administrator edit', async () => {
  const f = await setup()
  await f.suites.install(f.actor, request)
  await f.settled('installed')
  f.upgrade([preset('2.0.0')])
  expect((await f.suites.updatePreview(f.actor, request.id)).plugin).toMatchObject({ from: '1.0.0', to: '2.0.0', modified: false })
  await f.suites.update(f.actor, request.id)
  await f.settled('installed')
  expect((await f.rows.get('@fixture/editor'))?.version).toBe('2.0.0')
  expect((await f.accessStore.get('@fixture/editor'))?.environment[0]?.value).toBe('2.0.0')
  await f.access.save(f.actor, '@fixture/editor', { environment: [{ name: 'EDITOR_MODE', value: 'custom' }], entriesYaml: '' })
  f.upgrade([preset('3.0.0')])
  expect((await f.suites.updatePreview(f.actor, request.id)).plugin?.modified).toBe(true)
  await f.suites.update(f.actor, request.id)
  await f.settled('installed')
  expect((await f.rows.get('@fixture/editor'))?.version).toBe('3.0.0')
  expect((await f.accessStore.get('@fixture/editor'))?.environment[0]?.value).toBe('custom')
})
it('detaches a plugin so ordinary edits and uninstall leave it in place', async () => {
  const f = await setup()
  await f.suites.install(f.actor, request)
  await f.settled('installed')
  await f.suites.detach(f.actor, request.id, { kind: 'plugin', name: '@fixture/editor' })
  expect((await f.library.add(f.actor, { packageName: '@fixture/editor', version: '1.0.0' })).currentVersion).toBe('1.0.0')
  await f.suites.uninstall(f.actor, request.id)
  await expect.poll(async () => (await f.state()).installs.length).toBe(0)
  expect((await f.rows.get('@fixture/editor'))?.version).toBe('1.0.0')
})

it('restores the exact original settings and plugin when a write fails after applying the template', async () => {
  const f = await setup(),
    original: LibraryPlugin = { packageName: '@fixture/editor', version: '0.9.0', current: f.prepared('0.9.0'), stage: 'available', published: true }
  await f.rows.set('@fixture/editor', original)
  const originalStored = await f.rows.get('@fixture/editor')
  await f.access.save(f.actor, '@fixture/editor', { environment: [{ name: 'CUSTOM', value: 'manual' }], entriesYaml: '' })
  const settings = await f.accessStore.get('@fixture/editor')
  await f.reject('plugin_access_settings')
  await f.suites.install(f.actor, { ...request, replace: (await f.suites.installPreview(f.actor, request.id)).replacements })
  await f.settled('failed')
  expect(await f.rows.get('@fixture/editor')).toEqual(originalStored)
  expect(await f.accessStore.get('@fixture/editor')).toEqual(settings)
  expect(await f.accessStore.suiteCheckpoint('@fixture/editor')).toBeUndefined()
})
it('rolls a plugin update back after the package and template have switched', async () => {
  const f = await setup()
  await f.suites.install(f.actor, request)
  await f.settled('installed')
  const row = await f.rows.get('@fixture/editor'),
    settings = await f.accessStore.get('@fixture/editor')
  f.upgrade([preset('2.0.0')])
  await f.reject('plugin_library')
  await f.suites.update(f.actor, request.id)
  await f.settled('installed')
  expect(await f.rows.get('@fixture/editor')).toEqual(row)
  expect(await f.accessStore.get('@fixture/editor')).toEqual(settings)
  expect((await f.state()).installs[0]?.version).toBe('1.0.0')
})
it('rejects detach atomically and preserves the detached plugin and embedded resource after retry and uninstall', async () => {
  const f = await setup()
  const base = preset(),
    plugin = {
      ...item(),
      runtimeDependencies: ['editor-sdk'],
      access: { environment: [{ name: 'EDITOR_SDK', value: '{dependency:editor-sdk}' }], entriesYaml: '' },
    }
  const resource = {
    kind: 'runtime-dependency' as const,
    type: 'resource' as const,
    name: 'editor-sdk',
    prepareCommands: { amd64: 'prepare-sdk' },
    pathDirectories: [],
    commands: [],
  }
  f.upgrade([{ ...base, items: [resource, plugin] }])
  await f.suites.install(f.actor, request)
  await f.settled('installed')
  const before = await f.rows.get('@fixture/editor'),
    runtimeBefore = await f.dependencyRows.get('editor-sdk')
  await f.reject('plugin_library')
  await expect(f.suites.detach(f.actor, request.id, { kind: 'plugin', name: '@fixture/editor' })).rejects.toMatchObject({ sqlState: '23503' })
  expect(await f.rows.get('@fixture/editor')).toEqual(before)
  expect(await f.dependencyRows.get('editor-sdk')).toEqual(runtimeBefore)
  expect((await f.state()).installs[0]?.status).toBe('installed')
  await f.accept('plugin_library')
  await f.suites.detach(f.actor, request.id, { kind: 'plugin', name: '@fixture/editor' })
  expect((await f.state()).installs[0]?.entries).toEqual([])
  await f.suites.uninstall(f.actor, request.id)
  await expect.poll(async () => (await f.state()).installs.length).toBe(0)
  expect((await f.rows.get('@fixture/editor'))?.runtimeDependencies).toEqual(['editor-sdk'])
  expect((await f.dependencyRows.get('editor-sdk'))?.managedOrigin).toBeUndefined()
})
it('rejects an installed foreign catalog owner and preserves its plugin', async () => {
  const f = await setup()
  await f.suites.install(f.actor, request)
  await f.settled('installed')
  f.upgrade([preset(), { ...preset(), id: 'other-editor' }])
  expect(await f.suites.installPreview(f.actor, 'other-editor')).toMatchObject({ reason: 'plugin-conflicts', pluginConflicts: ['@fixture/editor'] })
  await expect(f.suites.install(f.actor, { ...request, id: 'other-editor', requestId: 'request-plugin-other-1' })).rejects.toThrow()
  expect((await f.rows.get('@fixture/editor'))?.suiteOrigin).toBe('suite:fixture-suite')
})
it('keeps committed plugin settings and its receipt when a later view publication fails', async () => {
  const f = await setup()
  let failed = false
  const unsubscribe = f.database.subscribeCommittedWrites(['dsh_phalanx.plugin_library'], async () => {
    unsubscribe()
    failed = true
    throw Error('post-COMMIT publisher unavailable')
  })
  await f.suites.install(f.actor, request)
  await f.settled('installed')
  expect(failed).toBe(true)
  const before = await f.rows.get('@fixture/editor'),
    settings = await f.accessStore.get('@fixture/editor')
  expect((await f.storage.requests.get(request.requestId))?.result.status).toBe('complete')
  expect((await f.state()).installs[0]?.entries).toEqual([{ kind: 'plugin', name: '@fixture/editor' }])
  await f.suites.recover()
  expect(await f.rows.get('@fixture/editor')).toEqual(before)
  expect(await f.accessStore.get('@fixture/editor')).toEqual(settings)
  expect((await f.suites.install(f.actor, request)).status).toBe('installed')
})

it('keeps a dependency shared with a skill until the last catalog reference is removed', async () => {
  const f = await setup()
  const shared: SuiteCatalogEntry = {
    category: 'dependency',
    id: 'shared',
    version: '1.0.0',
    title: text,
    description: text,
    source: text,
    items: [
      { kind: 'runtime-dependency', name: 'shared-cli', prepareCommands: { amd64: 'prepare-shared' }, pathDirectories: ['bin'], commands: ['shared-cli'] },
    ],
  }
  const skill: SuiteCatalogEntry = {
    category: 'suite',
    id: 'skill-entry',
    version: '1.0.0',
    title: text,
    description: text,
    source: text,
    identity: text,
    dependencies: ['shared'],
    items: [
      {
        kind: 'skill',
        source: { type: 'git', url: 'https://git.example/repository', commit: 'a'.repeat(40), path: 'skills' },
        names: ['one'],
        catalogDependencies: ['shared'],
      },
    ],
  }
  f.upgrade([{ ...preset(), dependencies: ['shared'], items: [{ ...item(), catalogDependencies: ['shared'] }] }, shared, skill])
  await f.suites.install(f.actor, request)
  await f.settled('installed')
  await f.suites.install(f.actor, { id: 'skill-entry', requestId: 'request-shared-000001' })
  await expect.poll(async () => (await f.state()).installs.find(row => row.id === 'skill-entry')?.status).toBe('installed')
  expect((await f.suites.uninstallPreview(f.actor, request.id)).dependencies[0]?.references).toContainEqual({ kind: 'skill', name: 'one' })
  await expect(f.suites.uninstall(f.actor, request.id, { removeDependencies: ['shared'] })).rejects.toThrow()
  await f.suites.uninstall(f.actor, request.id)
  await expect.poll(async () => (await f.state()).installs.some(row => row.id === request.id)).toBe(false)
  expect(await f.dependencyRows.has('shared-cli')).toBe(true)
  await f.suites.uninstall(f.actor, 'skill-entry', { removeDependencies: ['shared'] })
  await expect.poll(async () => await f.dependencyRows.has('shared-cli')).toBe(false)
})
it('installs multiple embedded resources and resolves renamed dependencies during updates', async () => {
  const f = await setup()
  // An unrelated manual resource already owns the preferred library name.
  await f.dependencyRows.set('editor-sdk', {
    name: 'editor-sdk',
    type: 'resource',
    source: 'manual',
    prepareCommand: 'manual-sdk',
    pathDirectories: [],
    stage: 'failed',
    checks: [],
    log: '',
    updatedAt: 0,
  })
  const resources = ['editor-sdk', 'editor-fonts'].map(name => ({
    kind: 'runtime-dependency' as const,
    type: 'resource' as const,
    name,
    prepareCommands: { amd64: 'prepare-' + name },
    pathDirectories: [],
    commands: [],
  }))
  const plugin = {
    ...item(),
    runtimeDependencies: ['editor-sdk', 'editor-fonts'],
    access: { environment: [{ name: 'EDITOR_SDK', value: '{dependency:editor-sdk}' }], entriesYaml: '' },
  }
  f.upgrade([{ ...preset(), items: [...resources, plugin] }])
  await f.suites.install(f.actor, request)
  await f.settled('installed')
  expect((await f.rows.get('@fixture/editor'))?.runtimeDependencies).toEqual(['editor-sdk-1', 'editor-fonts'])
  expect((await f.accessStore.get('@fixture/editor'))?.environment[0]?.value).toBe('{dependency:editor-sdk-1}')
  f.upgrade([
    { ...preset('2.0.0'), items: [...resources.map(row => ({ ...row, prepareCommands: { amd64: 'updated-' + row.name } })), { ...plugin, version: '2.0.0' }] },
  ])
  await f.suites.update(f.actor, request.id)
  await f.settled('installed')
  expect((await f.state()).installs.find(row => row.id === request.id)?.version).toBe('2.0.0')
  expect((await f.rows.get('@fixture/editor'))?.runtimeDependencies).toEqual(['editor-sdk-1', 'editor-fonts'])
  expect((await f.accessStore.get('@fixture/editor'))?.environment[0]?.value).toBe('{dependency:editor-sdk-1}')
})

it('keeps catalog actions pending while plugin preparation is held', async () => {
  const f = await setup(),
    prepare = f.port.prepareCatalogPlugin.bind(f.port)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  vi.spyOn(f.port, 'prepareCatalogPlugin').mockImplementation(async (...args) => {
    entered()
    await gate
    return prepare(...args)
  })
  await f.suites.install(f.actor, request)
  await started
  try {
    expect((await f.suites.catalog(f.actor)).installations[0]?.status).toBe('installing')
    await expect(f.suites.uninstallPreview(f.actor, request.id)).rejects.toMatchObject({ code: 'suite-task-running' })
  } finally {
    release()
    await f.suites.stop()
  }
  // stop cancels outstanding preparation before its fact transaction.
  expect((await f.suites.catalog(f.actor)).installations[0]?.status).toBe('failed')
  expect(await f.rows.count()).toBe(0)
})

it('releases a rejected plugin task without a settlement checkpoint and admits a fresh retry', async () => {
  const f = await setup()
  await f.reject('plugin_access_settings', 'INSERT')
  await f.suites.install(f.actor, request)
  await f.settled('failed')
  expect((await f.state()).installs[0]).not.toHaveProperty('pluginSettling')
  expect(await f.rows.count()).toBe(0)
  await f.accept('plugin_access_settings')
  await f.suites.install(f.actor, { ...request, requestId: 'request-plugin-retry-1' })
  await f.settled('installed')
  f.upgrade([preset('2.0.0')])
  await f.suites.update(f.actor, request.id)
  await f.settled('installed')
  expect((await f.accessStore.get('@fixture/editor'))?.environment[0]?.value).toBe('2.0.0')
})

it('updates a plugin while leaving its individually detached dependency manual', async () => {
  const f = await setup(),
    resource = {
      kind: 'runtime-dependency' as const,
      type: 'resource' as const,
      name: 'editor-sdk',
      prepareCommands: { amd64: 'prepare-sdk' },
      pathDirectories: [],
      commands: [],
    }
  const plugin = {
    ...item(),
    runtimeDependencies: ['editor-sdk'],
    access: { environment: [{ name: 'EDITOR_SDK', value: '{dependency:editor-sdk}' }], entriesYaml: '' },
  }
  f.upgrade([{ ...preset(), items: [resource, plugin] }])
  await f.suites.install(f.actor, request)
  await f.settled('installed')
  await f.suites.detach(f.actor, request.id, { kind: 'runtime-dependency', name: 'editor-sdk' })
  const before = await f.dependencyRows.get('editor-sdk')
  f.upgrade([
    {
      ...preset('2.0.0'),
      items: [
        { ...resource, prepareCommands: { amd64: 'updated-sdk' } },
        { ...plugin, version: '2.0.0' },
      ],
    },
  ])
  expect((await f.suites.updatePreview(f.actor, request.id)).dependencyChanges).toEqual([])
  await f.suites.update(f.actor, request.id)
  await f.settled('installed')
  expect((await f.rows.get('@fixture/editor'))?.version).toBe('2.0.0')
  expect(await f.dependencyRows.get('editor-sdk')).toEqual(before)
})
it('refuses an update whose retained administrator settings reference a removed dependency', async () => {
  const f = await setup(),
    resource = {
      kind: 'runtime-dependency' as const,
      type: 'resource' as const,
      name: 'editor-sdk',
      prepareCommands: { amd64: 'prepare-sdk' },
      pathDirectories: [],
      commands: [],
    }
  const plugin = {
    ...item(),
    runtimeDependencies: ['editor-sdk'],
    access: { environment: [{ name: 'EDITOR_SDK', value: '{dependency:editor-sdk}' }], entriesYaml: '' },
  }
  f.upgrade([{ ...preset(), items: [resource, plugin] }])
  await f.suites.install(f.actor, request)
  await f.settled('installed')
  await f.access.save(f.actor, '@fixture/editor', { environment: [{ name: 'EDITOR_SDK', value: '{dependency:editor-sdk}/custom' }], entriesYaml: '' })
  f.upgrade([preset('2.0.0')])
  await f.suites.update(f.actor, request.id)
  await f.settled('installed')
  expect((await f.rows.get('@fixture/editor'))?.version).toBe('1.0.0')
  expect((await f.accessStore.get('@fixture/editor'))?.environment[0]?.value).toBe('{dependency:editor-sdk}/custom')
  expect(await f.dependencyRows.has('editor-sdk')).toBe(true)
})

it('rejects a replacement confirmation after access settings have changed', async () => {
  const f = await setup()
  await f.rows.set('@fixture/editor', { packageName: '@fixture/editor', version: '0.9.0', current: f.prepared('0.9.0'), stage: 'available', published: true })
  const preview = await f.suites.installPreview(f.actor, request.id)
  await f.access.save(f.actor, '@fixture/editor', { environment: [{ name: 'MODE', value: 'changed' }], entriesYaml: '' })
  await expect(f.suites.install(f.actor, { ...request, replace: preview.replacements })).rejects.toThrow()
})
it('restores removed dependency rows when a switch fails after removing an old resource', async () => {
  const f = await setup(),
    resource = {
      kind: 'runtime-dependency' as const,
      type: 'resource' as const,
      name: 'editor-sdk',
      prepareCommands: { amd64: 'prepare-sdk' },
      pathDirectories: [],
      commands: [],
    }
  f.upgrade([{ ...preset(), items: [resource, { ...item(), runtimeDependencies: ['editor-sdk'] }] }])
  await f.suites.install(f.actor, request)
  await f.settled('installed')
  const before = await f.dependencyRows.get('editor-sdk')
  await f.reject('runtime_dependencies', 'DELETE')
  f.upgrade([preset('2.0.0')])
  await f.suites.update(f.actor, request.id)
  await f.settled('installed')
  expect((await f.rows.get('@fixture/editor'))?.version).toBe('1.0.0')
  expect(await f.dependencyRows.get('editor-sdk')).toEqual(before)
})

it('updates a plugin dependency taken over from a differently named manual command provider', async () => {
  const f = await setup(),
    tool = {
      kind: 'runtime-dependency' as const,
      name: 'editor-cli',
      prepareCommands: { amd64: 'prepare-cli' },
      pathDirectories: ['bin'],
      commands: ['editor-cli'],
    }
  await f.dependencyRows.set('manual-cli', {
    name: 'manual-cli',
    source: 'manual',
    prepareCommand: 'manual-cli',
    pathDirectories: ['bin'],
    stage: 'ready',
    checks: [],
    log: '',
    updatedAt: 0,
    current: {
      id: 'a'.repeat(64),
      identity: 'manual',
      directory: '/private/manual',
      mountedPath: '/mounted/manual',
      commands: ['editor-cli'],
      commandPaths: { 'editor-cli': '/mounted/manual/bin/editor-cli' },
      pathDirectories: ['bin'],
      bytes: 1,
      isolated: true,
      checks: [],
      log: '',
    },
  })
  const plugin = { ...item(), runtimeDependencies: ['editor-cli'] }
  f.upgrade([{ ...preset(), items: [tool, plugin] }])
  await f.suites.install(f.actor, { ...request, replace: (await f.suites.installPreview(f.actor, request.id)).replacements })
  await f.settled('installed')
  expect((await f.rows.get('@fixture/editor'))?.runtimeDependencies).toEqual(['manual-cli'])
  f.upgrade([
    {
      ...preset('2.0.0'),
      items: [
        { ...tool, prepareCommands: { amd64: 'prepare-cli-2' } },
        { ...plugin, version: '2.0.0' },
      ],
    },
  ])
  await f.suites.update(f.actor, request.id)
  await f.settled('installed')
  expect((await f.state()).installs[0]?.version).toBe('2.0.0')
  expect((await f.rows.get('@fixture/editor'))?.runtimeDependencies).toEqual(['manual-cli'])
})

it('retains both new runtime artifacts through later plugin preparation during update', async () => {
  const f = await setup()
  const tool = (name: string, version: number) => ({
    kind: 'runtime-dependency' as const,
    name,
    prepareCommands: { amd64: `prepare-${name}-${version}` },
    pathDirectories: ['bin'],
    commands: [name],
  })
  const entry = (version: number): SuiteCatalogSuiteEntry => ({
    ...preset(`${version}.0.0`),
    items: [tool('editor-cli', version), tool('editor-sdk', version), { ...item(`${version}.0.0`), runtimeDependencies: ['editor-cli', 'editor-sdk'] }],
  })
  f.upgrade([entry(1)])
  await f.suites.install(f.actor, request)
  await f.settled('installed')
  const artifacts = new Set<string>(),
    observed: boolean[] = [],
    prepare = f.dependencies.stageManaged.bind(f.dependencies),
    preparePlugin = f.port.prepareCatalogPlugin.bind(f.port)
  f.runtimeHooks.collect = async retained => {
    for (const id of artifacts) if (!retained.includes(id)) artifacts.delete(id)
  }
  vi.spyOn(f.dependencies, 'stageManaged').mockImplementation(async (...args) => {
    if (artifacts.size) {
      await f.dependencies.collectUnretained()
      observed.push(artifacts.size === 1)
    }
    const version = { ...(await prepare(...args)), id: createHash('sha256').update(args[0].prepareCommand).digest('hex') }
    artifacts.add(version.id)
    return version
  })
  vi.spyOn(f.port, 'prepareCatalogPlugin').mockImplementation(async (...args) => {
    await f.dependencies.collectUnretained()
    observed.push(artifacts.size === 2)
    return preparePlugin(...args)
  })
  f.upgrade([entry(2)])
  await f.suites.update(f.actor, request.id)
  await f.settled('installed')
  expect((await f.record())?.version).toBe('2.0.0')
  expect(observed).toEqual([true, true])
  expect([...artifacts].sort()).toEqual(['prepare-editor-cli-2', 'prepare-editor-sdk-2'].map(value => createHash('sha256').update(value).digest('hex')).sort())
})
