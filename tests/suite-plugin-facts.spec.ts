import { pluginCatalogRevision } from '../src/domain/plugin-library.js'
import { expect, it } from 'vitest'
import { YamlPluginAccessSyntax } from '../src/adapters/plugin-access-syntax.js'
import { MemberPluginUpstreams } from '../src/use-cases/member-plugin-upstreams.js'
import { PluginUpstreamAdministration } from '../src/use-cases/plugin-upstream-administration.js'
import { createSuiteStorage } from '../src/composition/suite-storage.js'
import { SuiteTransactions } from '../src/use-cases/suite-transactions.js'
import { assertCatalogPluginBindings, writeSuitePlugin } from '../src/use-cases/suite-plugin-facts.js'
import type { SuiteCatalogPluginItem } from '../src/domain/suite-catalog.js'
import type { CatalogPluginServiceSlot } from '../src/domain/suite-service-slots.js'
import { suiteInstallOrigin } from '../src/domain/suite-install.js'
import { imageUpstreamReady } from '../src/domain/plugin-upstream.js'
import { postgresSuiteService, suiteVersion } from './fixtures/postgres-suite-service.js'

const plugin = (version: 1 | 2) => {
  const item: SuiteCatalogPluginItem = {
    kind: 'plugin',
    packageName: 'fixture-editor',
    version: `${version}.0.0`,
    integrity: 'sha512-' + Buffer.alloc(64, version).toString('base64'),
    runtimeDependencies: [],
    catalogDependencies: [],
    access: { environment: [{ name: 'EDITOR_KEY', value: 'fictional-key-' + version }], entriesYaml: '' },
  }
  return {
    item,
    prepared: {
      packageName: item.packageName,
      version: item.version,
      integrity: item.integrity,
      artifact: 'artifacts/' + String(version).repeat(128),
      runtimeRevision: 'fixture',
      title: 'Editor',
      description: '',
      dependencies: {},
      bundlePatch: '- insert:\n  - id: main\n    name: editor\n',
    },
    accessRevision: 'none',
  }
}

const label = { en: 'Image', 'zh-CN': '图片' }
const imageSlot = {
  id: 'image',
  label,
  binding: {
    kind: 'json-settings',
    deferredUpstream: true,
    file: 'image-upstream.json',
    upstream: 'image-provider',
    fields: [
      { path: ['endpoint'], source: 'gateway-url' },
      { path: ['token'], source: 'service-token' },
      { path: ['model'], source: 'model' },
    ],
  },
  backends: [
    {
      id: 'openai',
      label,
      protocol: 'openai-image',
      mode: 'openai',
      fields: [{ name: 'model', type: 'text', required: true }],
      upstream: { model: 'model' },
    },
  ],
} satisfies CatalogPluginServiceSlot

it.each([
  { scenario: 'enabled', enabled: true, unreadable: false, credential: 'fixture-secret' },
  { scenario: 'disabled', enabled: false, unreadable: false, credential: 'fixture-secret' },
  { scenario: 'unreadable', enabled: true, unreadable: true, credential: 'fixture-secret' },
  { scenario: 'unreadable header', enabled: true, unreadable: true, credential: 'fixture-secret' },
  { scenario: 'long model', enabled: true, unreadable: false, credential: 'fixture-secret' },
  { scenario: 'missing credential', enabled: true, unreadable: false, credential: '' },
  { scenario: 'never configured', enabled: false, unreadable: false, credential: undefined },
])('migrates the legacy image settings when $scenario', async ({ scenario, enabled, unreadable, credential }) => {
  const f = await postgresSuiteService()
  const storage = createSuiteStorage(f.database)
  const before = plugin(1)
  const after = plugin(2)
  const name = before.item.packageName
  const identity = { id: 'fixture-plugin', version: '1.0.0' }
  const origin = suiteInstallOrigin(identity.id)
  const syntax = new YamlPluginAccessSyntax()
  const legacyModel = scenario === 'long model' ? 'm'.repeat(300) : 'legacy-active-model'
  const corruptHeader = scenario === 'unreadable header'
  const legacy = {
    ...imageSlot,
    binding: { kind: 'json-settings', file: imageSlot.binding.file, upstream: imageSlot.binding.upstream, fields: imageSlot.binding.fields },
    backends: [{ ...imageSlot.backends[0]!, fields: [{ name: 'MODEL', type: 'text', required: true }], upstream: { model: 'MODEL' } }],
  } satisfies CatalogPluginServiceSlot
  const provider = {
    name: 'image-provider',
    baseUrl: 'https://example.test/v1',
    model: 'unused-upstream-model',
    credential: credential ?? '',
    headers: [{ name: 'X-Request-Key', value: '{credential}' }],
  }
  try {
    await storage.work.run(async rows => {
      await writeSuitePlugin(rows, origin, { ...before, item: { ...before.item, serviceSlots: [legacy] } }, [], 'install', {
        syntax,
        serviceIdentity: identity,
      })
      if (credential === undefined) return
      await rows.pluginUpstreams.save(name, [provider])
      const services = (await rows.pluginAccess.installedServices!(name))!
      await rows.pluginAccess.saveInstalledServices!(
        name,
        origin,
        { ...services.configuration, settings: [{ slot: 'image', backend: 'openai', enabled, values: { MODEL: legacyModel } }] },
        services.revision,
      )
    })
    if (unreadable)
      await f.database.query(
        corruptHeader
          ? 'UPDATE dsh_phalanx.plugin_upstreams SET headers=jsonb_build_array(credential) WHERE package_name=$1 AND name=$2'
          : 'UPDATE dsh_phalanx.plugin_upstreams SET credential=headers->0 WHERE package_name=$1 AND name=$2',
        [name, provider.name],
      )
    const readProtected = () =>
      f.database.query('SELECT credential, headers FROM dsh_phalanx.plugin_upstreams WHERE package_name=$1 AND name=$2', [name, provider.name])
    const originalProtected = await readProtected()
    const update = (rows: Parameters<typeof writeSuitePlugin>[0]) =>
      writeSuitePlugin(rows, origin, { ...after, item: { ...after.item, serviceSlots: [imageSlot] } }, [], 'update', {
        syntax,
        serviceIdentity: { ...identity, version: '2.0.0' },
      })
    if (scenario === 'enabled') {
      await expect(
        storage.work.run(async rows => {
          await update(rows)
          throw Error('interrupted update')
        }),
      ).rejects.toThrow('interrupted update')
      expect(await readProtected()).toEqual(originalProtected)
      await storage.work.run(async rows => {
        expect((await rows.pluginAccess.installedServices!(name))?.configuration.ownerVersion).toBe(before.item.integrity)
        expect((await rows.pluginUpstreams.list(name))[0]?.model).toBe(provider.model)
      })
    }
    await storage.work.run(update)
    await storage.work.run(async rows => {
      const upstreams = await rows.pluginUpstreams.list(name)
      expect(upstreams).toHaveLength(1)
      expect(upstreams[0]).toMatchObject({ name: provider.name, nativeServiceOnly: true })
      expect(upstreams[0]?.model).toBe(credential === undefined ? undefined : legacyModel)
      expect(upstreams[0]?.baseUrl).toBe(credential === undefined ? '' : provider.baseUrl)
      expect(upstreams[0]?.credential).toBe(unreadable && !corruptHeader ? '' : provider.credential)
      if (credential !== undefined) expect(upstreams[0]?.headers).toEqual(corruptHeader ? [{ name: 'X-Request-Key', value: '' }] : provider.headers)
      expect(imageUpstreamReady(upstreams[0])).toBe(enabled && !unreadable && Boolean(credential))
      expect(await rows.pluginAccess.installedServices!(name)).toMatchObject({ configuration: { ownerVersion: after.item.integrity, settings: [] } })
    })
    if (credential !== undefined) expect(await readProtected()).toEqual(originalProtected)
    if (unreadable) {
      await storage.work.run(async rows => {
        const administration = new PluginUpstreamAdministration(f.accounts, rows.plugins, rows.pluginUpstreams, undefined, rows.pluginAccess)
        const [unavailable] = await administration.list(f.actor, name)
        expect(unavailable).toMatchObject({
          credential: { configured: corruptHeader, last4: '' },
          managedImage: { ready: false, credentialUnavailable: true },
        })
        const repair = {
          action: 'save',
          expectedRevision: unavailable!.managedImage!.revision!,
          upstream: {
            name: provider.name,
            baseUrl: provider.baseUrl,
            headers: corruptHeader ? provider.headers : [],
            ...(corruptHeader ? {} : { credential: 'replacement-fixture-key' }),
          },
        } as const
        if (corruptHeader)
          await expect(administration.execute(f.actor, name, { ...repair, upstream: { ...repair.upstream, headers: [] } })).rejects.toMatchObject({
            code: 'plugin-upstream-invalid',
          })
        const [restored] = await administration.execute(f.actor, name, repair)
        expect(restored).toMatchObject({
          model: legacyModel,
          credential: { configured: true, last4: '' },
          managedImage: { ready: true },
        })
        expect(restored?.managedImage).not.toHaveProperty('credentialUnavailable')
        expect((await rows.pluginUpstreams.list(name))[0]?.headers).toEqual(provider.headers)
      })
    }
  } finally {
    await f.close()
  }
})

it.each([true, false])('reserves the native upstream at adoption and retains its scope after removal (previous row: %s)', async ready => {
  const f = await postgresSuiteService()
  const storage = createSuiteStorage(f.database)
  const original = plugin(1)
  const name = original.item.packageName
  const identity = { id: 'fixture-plugin', version: '1.0.0' }
  const origin = suiteInstallOrigin(identity.id)
  const provider = {
    name: 'image-provider',
    baseUrl: 'https://example.test/v1',
    model: 'fixture-model',
    credential: 'fixture-secret',
    headers: [{ name: 'Authorization', value: 'Bearer {credential}' }],
  }
  const ordinary = { ...provider, name: 'other' }
  const pending = {
    name: provider.name,
    baseUrl: '',
    credential: '',
    headers: provider.headers,
    testRequest: { method: 'GET', path: '/models' },
  }
  const syntax = new YamlPluginAccessSyntax()
  try {
    await storage.work.run(async rows => {
      await rows.plugins.save({
        packageName: name,
        version: original.item.version,
        source: { kind: 'npm' },
        stage: 'available',
        current: original.prepared,
        published: true,
      })
      if (ready) await rows.pluginUpstreams.save(name, [provider, ordinary])
    })
    const stale = await storage.work.run(async rows => await rows.pluginUpstreams.revision!(name))
    const stalePlugin = await storage.work.run(async rows => (await rows.plugins.list())[0]!.revision)
    await storage.work.run(async rows => {
      const row = (await rows.plugins.list())[0]!
      const item = { ...original.item, serviceSlots: [imageSlot] }
      await writeSuitePlugin(rows, origin, { ...original, item }, [], 'install', {
        syntax,
        serviceIdentity: identity,
        takeover: { row, revision: pluginCatalogRevision(row, 'none') },
      })
    })
    await expect(storage.work.run(rows => rows.pluginUpstreams.save(name, [provider], undefined, stale))).rejects.toMatchObject({
      code: 'platform-configuration-conflict',
    })
    const latest = await storage.work.run(async rows => await rows.pluginUpstreams.revision!(name))
    await expect(storage.work.run(rows => rows.pluginUpstreams.save(name, [], undefined, latest, stalePlugin))).rejects.toMatchObject({
      code: 'platform-configuration-conflict',
    })
    await storage.work.run(async rows => {
      await writeSuitePlugin(rows, origin, original, [], 'update', { syntax, serviceIdentity: { ...identity, version: '1.0.1' } })
      expect(await rows.pluginAccess.installedServices?.(name)).toBeUndefined()
      expect(await rows.pluginUpstreams.list(name)).toEqual([{ ...(ready ? provider : pending), nativeServiceOnly: true }, ...(ready ? [ordinary] : [])])
      const members = new MemberPluginUpstreams(
        { list: rows.pluginUpstreams.list.bind(rows.pluginUpstreams), authorizationRevision: () => 'fixture' },
        {
          installedServices: rows.pluginAccess.installedServices!.bind(rows.pluginAccess),
        },
      )
      expect(await members.list(name)).toEqual(ready ? [ordinary] : [])
      expect((await rows.plugins.list())[0]?.published).toBe(true)
    })
  } finally {
    await f.close()
  }
})

it('requires native package cache pins to cover the original dependency names and ranges', () => {
  const { item, prepared } = plugin(1)
  const pins = [
    { packageName: 'fixture-export', version: '2.1.0' },
    { packageName: 'fixture-renderer', version: '1.3.0' },
  ]
  const cache = { kind: 'native-package-cache' as const, dependency: 'cache', version: '1.0.0', contentHash: 'a'.repeat(64), path: 'cache' }
  const check = (packages: typeof pins) =>
    assertCatalogPluginBindings(
      { ...item, resourceBindings: [{ ...cache, packages }] },
      { ...prepared, dependencies: { 'fixture-export': '^2.0.0', 'fixture-renderer': '~1.3.0' } },
    )
  expect(() => check(pins)).not.toThrow()
  expect(() => check(pins.slice(0, 1))).toThrow('package cache pins')
  expect(() => check([...pins, { packageName: 'undeclared', version: '1.0.0' }])).toThrow('package cache pins')
  expect(() => check([{ ...pins[0]!, version: '3.0.0' }, pins[1]!])).toThrow('package cache pins')
})

it('requires the selected Playwright browser to match the exact member package pin', () => {
  const { item, prepared } = plugin(1)
  const browser = {
    kind: 'playwright-browser' as const,
    dependency: 'chromium-1248',
    version: '1.0.0',
    contentHash: 'a'.repeat(64),
    path: 'assets',
    playwrightVersion: '1.64.1',
    chromiumBuild: '1248',
    directories: ['chromium_headless_shell-1248'],
  }
  const cache = {
    kind: 'native-package-cache' as const,
    dependency: 'cache',
    version: '1.0.0',
    contentHash: 'b'.repeat(64),
    path: 'cache',
    packages: [{ packageName: 'playwright', version: '1.64.1' }],
  }
  const check = (range: string, configuredCache = false) =>
    assertCatalogPluginBindings(
      { ...item, resourceBindings: configuredCache ? [browser, cache] : [browser] },
      { ...prepared, dependencies: { playwright: range } },
    )
  expect(() => check('1.64.1')).not.toThrow()
  expect(() => check('^1.64.0', true)).not.toThrow()
  expect(() => check('^1.64.0')).toThrow('Playwright')
  expect(() => check('1.65.1')).toThrow('Playwright')
  expect(() => assertCatalogPluginBindings({ ...item, resourceBindings: [browser] }, prepared)).toThrow('Playwright')
})

it('commits prepared plugin bytes, protected template settings and catalog receipt together without a recovery checkpoint', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database),
    unit = new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 }, { syntax: new YamlPluginAccessSyntax() })
  try {
    const prepared = plugin(1)
    const plan = { ...prepared, item: { ...prepared.item, serviceSlots: [imageSlot] } }
    const entry = { ...suiteVersion(1), category: 'plugin' as const, id: 'fixture-plugin', items: [plan.item] }
    const imageSettings = { name: 'image-provider', baseUrl: 'https://images.example.test/v1', model: 'fixture-image', credential: 'fictional-install-key' }
    const options = { id: entry.id, requestId: 'request-plugin-transaction', imageSettings: [imageSettings] }
    await storage.installs.save({
      id: entry.id,
      version: '1',
      category: 'plugin',
      pluginPackage: plan.item.packageName,
      status: 'installing',
      entries: [],
      requestId: options.requestId,
      updatedAt: 1,
      log: 'Installing.',
    })
    await storage.requests.save(options.requestId, { id: entry.id, version: '1', status: 'pending' })
    const installed = (await storage.installs.get(entry.id))!,
      request = (await storage.requests.get(options.requestId))!,
      units = [{ installed, entry, runtime: [], skills: [], plugin: plan }]
    await f.database.query(`CREATE TABLE dsh_phalanx.reject_plugin_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_plugin_child(id integer REFERENCES dsh_phalanx.reject_plugin_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_plugin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dsh_phalanx.reject_plugin_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_plugin AFTER UPDATE ON dsh_phalanx.catalog_installs FOR EACH ROW WHEN (NEW.state='installed') EXECUTE FUNCTION dsh_phalanx.reject_plugin();`)
    await expect(unit.install(f.actor, units, options, request)).rejects.toMatchObject({ sqlState: '23503' })
    expect(await storage.work.run(rows => rows.plugins.list())).toEqual([])
    expect(await storage.work.run(async rows => rows.pluginAccess.get(plan.item.packageName))).toBeUndefined()
    expect(await storage.work.run(async rows => await rows.pluginUpstreams.list(plan.item.packageName))).toEqual([])
    expect(await storage.requests.get(options.requestId)).toEqual(request)
    expect(await storage.installs.get(entry.id)).toEqual(installed)
    await f.database.query('DROP TRIGGER reject_plugin ON dsh_phalanx.catalog_installs')
    await unit.install(f.actor, units, options, request)
    expect((await storage.installs.get(entry.id))?.record.entries).toEqual([{ kind: 'plugin', name: plan.item.packageName }])
    expect((await storage.work.run(rows => rows.plugins.list()))[0]).toMatchObject({
      version: '1.0.0',
      current: plan.prepared,
      display: { catalogDefaults: { title: entry.title, description: entry.description } },
    })
    expect(await storage.work.run(async rows => rows.pluginAccess.get(plan.item.packageName))).toMatchObject({ environment: plan.item.access.environment })
    const raw = await f.database.query<{ configuration: Record<string, unknown> }>(
      'SELECT configuration FROM dsh_phalanx.plugin_access_settings WHERE package_name=$1',
      [plan.item.packageName],
    )
    expect(raw[0]!.configuration).not.toHaveProperty('checkpoint')
    expect(await storage.work.run(async rows => await rows.pluginUpstreams.list(plan.item.packageName))).toMatchObject([
      {
        ...imageSettings,
        nativeServiceOnly: true,
      },
    ])
    expect(JSON.stringify(await storage.installs.get(entry.id))).not.toContain(imageSettings.credential)
    expect(JSON.stringify(await storage.requests.get(options.requestId))).not.toContain(imageSettings.credential)
    await storage.work.run(async rows => {
      const installed = (await rows.plugins.list())[0]!
      await rows.plugins.save({ ...installed, display: { ...installed.display, name: 'Team catalog editor' } })
    })
    const before = await storage.work.run(async rows => ({ plugin: await rows.plugins.list(), access: await rows.pluginAccess.get(plan.item.packageName) }))
    await unit.install(f.actor, units, options, request)
    expect(await storage.work.run(async rows => ({ plugin: await rows.plugins.list(), access: await rows.pluginAccess.get(plan.item.packageName) }))).toEqual(
      before,
    )
    const update = plugin(2)
    const next = {
      ...update,
      item: { ...update.item, archive: { url: 'https://github.com/fixture/editor/releases/download/v2.0.0/editor.tgz' } },
    }
    const previous = (await storage.installs.get(entry.id))!
    const updatedEntry = { ...entry, version: '2', title: { en: 'Updated editor', 'zh-CN': '新版编辑器' }, items: [next.item] }
    await f.database.query(
      "CREATE TRIGGER reject_plugin AFTER UPDATE ON dsh_phalanx.catalog_installs FOR EACH ROW WHEN (NEW.state='installed') EXECUTE FUNCTION dsh_phalanx.reject_plugin()",
    )
    await expect(unit.update(f.actor, { installed: previous, entry: updatedEntry, runtime: [], skills: [], plugin: next })).rejects.toMatchObject({
      sqlState: '23503',
    })
    expect(await storage.work.run(async rows => ({ plugin: await rows.plugins.list(), access: await rows.pluginAccess.get(plan.item.packageName) }))).toEqual(
      before,
    )
    expect(await storage.installs.get(entry.id)).toEqual(previous)
    await f.database.query('DROP TRIGGER reject_plugin ON dsh_phalanx.catalog_installs')
    await unit.update(f.actor, { installed: previous, entry: updatedEntry, runtime: [], skills: [], plugin: next })
    expect((await storage.work.run(rows => rows.plugins.list()))[0]).toMatchObject({
      version: '2.0.0',
      source: { kind: 'upload' },
      current: { ...next.prepared, catalogArchiveUrl: next.item.archive.url },
      display: { name: 'Team catalog editor', catalogDefaults: { title: updatedEntry.title, description: updatedEntry.description } },
    })
    expect((await storage.work.run(async rows => rows.pluginAccess.get(plan.item.packageName)))?.environment).toEqual(next.item.access.environment)
  } finally {
    await f.close()
  }
})

it('preserves a newer administrator plugin template and its revision during catalog update', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database),
    unit = new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 }, { syntax: new YamlPluginAccessSyntax() })
  try {
    const plan = plugin(1),
      entry = { ...suiteVersion(1), category: 'plugin' as const, id: 'fixture-plugin', items: [plan.item] },
      options = { id: entry.id, requestId: 'request-plugin-transaction' }
    await storage.installs.save({
      id: entry.id,
      version: '1',
      category: 'plugin',
      pluginPackage: plan.item.packageName,
      status: 'installing',
      entries: [],
      requestId: options.requestId,
      updatedAt: 1,
      log: 'Installing.',
    })
    await storage.requests.save(options.requestId, { id: entry.id, version: '1', status: 'pending' })
    await unit.install(
      f.actor,
      [{ installed: (await storage.installs.get(entry.id))!, entry, runtime: [], skills: [], plugin: plan }],
      options,
      (await storage.requests.get(options.requestId))!,
    )
    await storage.work.run(rows =>
      rows.pluginAccess.save(plan.item.packageName, {
        environment: [{ name: 'EDITOR_KEY', value: 'fictional-administrator-key' }],
        entriesYaml: '',
        entries: {},
      }),
    )
    const before = await storage.work.run(async rows => ({
      access: await rows.pluginAccess.get(plan.item.packageName),
      baseline: (await rows.plugins.list())[0]!.suiteAppliedAccess,
    }))
    const next = plugin(2)
    await unit.update(f.actor, {
      installed: (await storage.installs.get(entry.id))!,
      entry: { ...entry, version: '2', items: [next.item] },
      runtime: [],
      skills: [],
      plugin: next,
    })
    expect(await storage.work.run(async rows => rows.pluginAccess.get(plan.item.packageName))).toEqual(before.access)
    expect((await storage.work.run(rows => rows.plugins.list()))[0]).toMatchObject({ version: '2.0.0', suiteAppliedAccess: before.baseline })
  } finally {
    await f.close()
  }
})

it('does not reattach a detached plugin while recording the next catalog version', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database),
    unit = new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 }, { syntax: new YamlPluginAccessSyntax() })
  try {
    const plan = plugin(1),
      entry = { ...suiteVersion(1), category: 'plugin' as const, id: 'fixture-plugin', items: [plan.item] },
      options = { id: entry.id, requestId: 'request-plugin-transaction' }
    await storage.installs.save({
      id: entry.id,
      version: '1',
      category: 'plugin',
      pluginPackage: plan.item.packageName,
      status: 'installing',
      entries: [],
      requestId: options.requestId,
      updatedAt: 1,
      log: 'Installing.',
    })
    await storage.requests.save(options.requestId, { id: entry.id, version: '1', status: 'pending' })
    await unit.install(
      f.actor,
      [{ installed: (await storage.installs.get(entry.id))!, entry, runtime: [], skills: [], plugin: plan }],
      options,
      (await storage.requests.get(options.requestId))!,
    )
    await storage.work.run(async rows => {
      const current = (await rows.plugins.list())[0]!,
        { suiteOrigin, ...manual } = current
      void suiteOrigin
      await rows.plugins.save(manual)
      const record = (await rows.installs.get(entry.id))!
      await rows.installs.save({ ...record.record, entries: [], detached: [{ kind: 'plugin', name: plan.item.packageName }] }, record.revision)
    })
    const before = await storage.work.run(async rows => ({ plugin: await rows.plugins.list(), access: await rows.pluginAccess.get(plan.item.packageName) })),
      next = plugin(2)
    await unit.update(f.actor, {
      installed: (await storage.installs.get(entry.id))!,
      entry: { ...entry, version: '2', items: [next.item] },
      runtime: [],
      skills: [],
    })
    expect((await storage.installs.get(entry.id))?.record).toMatchObject({
      version: '2',
      entries: [],
      detached: [{ kind: 'plugin', name: plan.item.packageName }],
    })
    expect(await storage.work.run(async rows => ({ plugin: await rows.plugins.list(), access: await rows.pluginAccess.get(plan.item.packageName) }))).toEqual(
      before,
    )
  } finally {
    await f.close()
  }
})

it('records a confirmed manual plugin takeover while retaining publication and contributor credit', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database),
    unit = new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 }, { syntax: new YamlPluginAccessSyntax() })
  try {
    const old = plugin(1),
      next = plugin(2),
      provenance = { maintainer: { username: f.actor.username, spaceId: f.actor.spaceId }, anonymous: true, versions: [] },
      entry = { ...suiteVersion(1), category: 'plugin' as const, id: 'fixture-plugin', version: '2', items: [next.item] },
      options = { id: entry.id, requestId: 'request-plugin-manual-takeover' }
    await storage.work.run(async rows => {
      await rows.plugins.save({
        source: { kind: 'npm' as const },
        packageName: old.item.packageName,
        version: old.item.version,
        current: old.prepared,
        stage: 'available',
        published: true,
        provenance,
      })
      await rows.pluginAccess.save(old.item.packageName, { environment: old.item.access.environment, entriesYaml: '', entries: {} })
    })
    await storage.installs.save({
      id: entry.id,
      version: '2',
      category: 'plugin',
      pluginPackage: next.item.packageName,
      status: 'installing',
      entries: [],
      requestId: options.requestId,
      updatedAt: 1,
      log: 'Installing.',
    })
    await storage.requests.save(options.requestId, { id: entry.id, version: '2', status: 'pending' })
    const current = (await storage.work.run(rows => rows.plugins.list()))[0]!,
      access = (await storage.work.run(async rows => rows.pluginAccess.get(old.item.packageName)))!,
      confirmed = { row: current, revision: pluginCatalogRevision(current, access.revision) },
      installed = (await storage.installs.get(entry.id))!,
      request = (await storage.requests.get(options.requestId))!,
      makePlan = (settings: typeof access, takeover: typeof confirmed) => [
        {
          installed,
          entry,
          runtime: [],
          skills: [],
          plugin: { ...next, accessRevision: settings.revision },
          replacement: { dependencies: new Map(), skills: [], executions: [], plugins: [takeover] },
        },
      ]
    await storage.work.run(rows =>
      rows.pluginAccess.save(old.item.packageName, { environment: [{ name: 'EDITOR_KEY', value: 'fictional-newer-key' }], entriesYaml: '', entries: {} }),
    )
    const latest = (await storage.work.run(async rows => rows.pluginAccess.get(old.item.packageName)))!
    await expect(unit.install(f.actor, makePlan(access, confirmed), options, request)).rejects.toMatchObject({ code: 'plugin-impact-changed' })
    expect((await storage.work.run(rows => rows.plugins.list()))[0]).toEqual(current)
    expect(await storage.work.run(async rows => rows.pluginAccess.get(old.item.packageName))).toEqual(latest)
    await unit.install(f.actor, makePlan(latest, { row: current, revision: pluginCatalogRevision(current, latest.revision) }), options, request)
    expect((await storage.work.run(rows => rows.plugins.list()))[0]).toMatchObject({ version: '2.0.0', published: true, provenance })
    expect((await storage.installs.get(entry.id))?.record.replaced).toEqual([{ kind: 'plugin', name: old.item.packageName }])
  } finally {
    await f.close()
  }
})

it('rechecks the locked shared artifact before committing a prepared plugin', async () => {
  const f = await postgresSuiteService()
  const storage = createSuiteStorage(f.database)
  const transactions = new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 }, { syntax: new YamlPluginAccessSyntax() })
  try {
    const dependency = 'shared-assets'
    const original = plugin(1)
    const item = {
      ...original.item,
      catalogDependencies: [dependency],
      resourceBindings: [{ dependency, version: '1.0.0', contentHash: 'a'.repeat(64), name: 'ASSET_ROOT', path: '.' }],
    }
    const entry = { ...suiteVersion(1), category: 'plugin' as const, id: 'fixture-plugin', dependencies: [dependency], items: [item] }
    const options = { id: entry.id, requestId: 'request-pinned-resource' }
    await storage.installs.save({
      id: dependency,
      category: 'dependency',
      version: '1.0.0',
      contentHash: 'b'.repeat(64),
      locked: true,
      status: 'installed',
      entries: [{ kind: 'runtime-dependency', name: 'shared-assets' }],
      updatedAt: 1,
      log: '',
    })
    await storage.installs.save({
      id: entry.id,
      version: entry.version,
      category: 'plugin',
      status: 'installing',
      entries: [],
      dependencies: [dependency],
      requestId: options.requestId,
      updatedAt: 1,
      log: '',
    })
    await storage.requests.save(options.requestId, { id: entry.id, version: entry.version, status: 'pending' })
    const installed = (await storage.installs.get(entry.id))!
    const request = (await storage.requests.get(options.requestId))!
    await expect(
      transactions.install(f.actor, [{ installed, entry, runtime: [], skills: [], plugin: { ...original, item } }], options, request),
    ).rejects.toMatchObject({ code: 'suite-dependency-missing' })
    const unpinned = { ...item, resourceBindings: [] }
    await expect(
      transactions.install(
        f.actor,
        [{ installed, entry: { ...entry, items: [unpinned] }, runtime: [], skills: [], plugin: { ...original, item: unpinned } }],
        options,
        request,
      ),
    ).rejects.toMatchObject({ code: 'suite-dependency-missing' })
    expect(await storage.installs.get(entry.id)).toEqual(installed)
    expect(await storage.requests.get(options.requestId)).toEqual(request)
    expect(await storage.work.run(rows => rows.plugins.list())).toEqual([])
  } finally {
    await f.close()
  }
})

it('rejects an unavailable or already supplied browser build before writing a signed plugin', async () => {
  const original = plugin(1)
  const firstPin = { dependency: 'old-cache', version: '1.0.0', contentHash: 'a'.repeat(64), path: 'assets' }
  const nextPin = { ...firstPin, dependency: 'new-cache', contentHash: 'b'.repeat(64) }
  const binding = {
    ...nextPin,
    kind: 'playwright-browser' as const,
    playwrightVersion: '1.64.1',
    chromiumBuild: '1248',
    directories: ['chromium_headless_shell-1248'],
  }
  const plan = {
    ...original,
    item: { ...original.item, catalogDependencies: [nextPin.dependency], resourceBindings: [binding] },
    prepared: { ...original.prepared, dependencies: { playwright: '1.64.1' } },
  }
  let installedBindings: object[] = []
  let memberBindings: object[] = []
  const list = new Map<string, readonly string[]>([
    ['/old/assets', ['chromium-1248']],
    ['/new/assets', []],
  ])
  const browserDirectories = async (directory: string) => list.get(directory) ?? []
  const rows = {
    plugins: { list: async () => (installedBindings.length ? [{ packageName: 'existing-editor', suiteResourceBindings: installedBindings }] : []) },
    pluginAccess: { get: async () => undefined },
    pluginUpstreams: {
      list: async () => {
        throw Error('Competing browser reached plugin template validation')
      },
    },
    runtimeReferences: { retainedBrowserBindings: async () => memberBindings },
    runtime: {
      list: async () => [
        { name: 'new-cache', current: { directory: '/new' } },
        { name: 'old-cache', current: { directory: '/old' } },
      ],
    },
  } as unknown as Parameters<typeof writeSuitePlugin>[0]
  const write = (item: SuiteCatalogPluginItem = plan.item) =>
    writeSuitePlugin(rows, 'suite:fixture-plugin', { ...plan, item }, ['new-cache'], 'install', { syntax: new YamlPluginAccessSyntax(), browserDirectories })
  await expect(write()).rejects.toThrow('Prepared Playwright browser build is unavailable')
  list.set('/new/assets', binding.directories)
  installedBindings = [{ ...firstPin, kind: 'environment', name: 'PLAYWRIGHT_BROWSERS_PATH', runtimeDependency: 'old-cache' }]
  await expect(write()).rejects.toThrow('Playwright browser build already has a locked resource')
  installedBindings = [{ ...binding, ...firstPin, runtimeDependency: 'old-cache' }]
  await expect(write()).rejects.toThrow('Playwright browser build already has a locked resource')
  const legacy = { ...nextPin, kind: 'environment' as const, name: 'PLAYWRIGHT_BROWSERS_PATH' }
  await expect(write({ ...plan.item, resourceBindings: [legacy] })).rejects.toThrow('Playwright browser build already has a locked resource')
  memberBindings = installedBindings
  installedBindings = []
  await expect(write()).rejects.toThrow('Playwright browser build already has a locked resource')
})

it('keeps the same locked resource through a signed replacement and subsequent releases', async () => {
  const f = await postgresSuiteService()
  const storage = createSuiteStorage(f.database)
  const previous = plugin(2)
  const target = plugin(1)
  const from = { version: previous.item.version, integrity: previous.item.integrity }
  const to = { version: target.item.version, integrity: target.item.integrity }
  const dependency = 'locked-assets'
  const binding = { dependency, version: '1.0.0', contentHash: 'a'.repeat(64), name: 'ASSET_ROOT', path: 'bin/tool' }
  const withResource = ({ item, ...plan }: typeof previous, path = binding.path) => ({
    ...plan,
    item: {
      ...item,
      catalogDependencies: [dependency],
      resourceBindings: [{ ...binding, path }],
      access: { ...item.access, environment: [...item.access.environment, { name: binding.name, value: '{dependency:' + dependency + '}/' + path }] },
    },
  })
  const initial = withResource(previous)
  const candidate = withResource(target)
  const declared = { ...candidate, item: { ...candidate.item, replaces: from } }
  const origin = suiteInstallOrigin('fixture-plugin')
  const syntax = new YamlPluginAccessSyntax()
  const row = () => storage.work.run(async rows => (await rows.plugins.list())[0])
  const update = async (plan: typeof declared | typeof candidate) => {
    const accessRevision = (await storage.work.run(async rows => rows.pluginAccess.get(previous.item.packageName)))!.revision
    await storage.work.run(rows => writeSuitePlugin(rows, origin, { ...plan, accessRevision }, [dependency], 'update', { syntax }))
  }
  try {
    await storage.work.run(async rows => {
      await rows.runtime.save({
        name: dependency,
        type: 'resource',
        prepareCommand: 'fixture',
        pathDirectories: [],
        source: 'suite-catalog',
        stage: 'ready',
        updatedAt: 1,
        log: '',
        checks: [],
        current: {
          id: 'a'.repeat(64),
          identity: 'fixture',
          directory: '/fixture',
          mountedPath: '/fixture',
          pathDirectories: [],
          commands: [],
          commandPaths: {},
          bytes: 1,
          isolated: true,
          checks: [],
          log: '',
        },
      })
      await writeSuitePlugin(rows, origin, initial, [dependency], 'install', { syntax })
    })
    const original = await row()
    const changed = withResource(target, 'bin/different')
    await expect(update({ ...changed, item: { ...changed.item, replaces: from } })).rejects.toMatchObject({ code: 'plugin-impact-changed' })
    expect(await row()).toEqual(original)

    await update(declared)
    expect(await row()).toMatchObject({ version: to.version, catalogReplacement: { from, to } })
    const newer = { version: '1.1.0', integrity: 'sha512-' + Buffer.alloc(64, 3).toString('base64') }
    await update({ ...declared, item: { ...declared.item, ...newer }, prepared: { ...declared.prepared, ...newer } })
    expect(await row()).toMatchObject({ version: newer.version, catalogReplacement: { from, to: newer } })
    await update({ ...candidate, item: { ...candidate.item, ...newer }, prepared: { ...candidate.prepared, ...newer } })
    expect((await row())?.catalogReplacement).toBeUndefined()
  } finally {
    await f.close()
  }
})
