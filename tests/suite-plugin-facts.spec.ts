import { pluginCatalogRevision } from '../src/domain/plugin-library.js'
import { expect, it } from 'vitest'
import { YamlPluginAccessSyntax } from '../src/adapters/plugin-access-syntax.js'
import { createSuiteStorage } from '../src/composition/suite-storage.js'
import { SuiteTransactions } from '../src/use-cases/suite-transactions.js'
import type { SuiteCatalogPluginItem } from '../src/domain/suite-catalog.js'
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

it('commits prepared plugin bytes, protected template settings and catalog receipt together without a recovery checkpoint', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database),
    unit = new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 }, new YamlPluginAccessSyntax())
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
    expect(await storage.requests.get(options.requestId)).toEqual(request)
    expect(await storage.installs.get(entry.id)).toEqual(installed)
    await f.database.query('DROP TRIGGER reject_plugin ON dsh_phalanx.catalog_installs')
    await unit.install(f.actor, units, options, request)
    expect((await storage.installs.get(entry.id))?.record.entries).toEqual([{ kind: 'plugin', name: plan.item.packageName }])
    expect((await storage.work.run(rows => rows.plugins.list()))[0]).toMatchObject({ version: '1.0.0', current: plan.prepared })
    expect(await storage.work.run(async rows => rows.pluginAccess.get(plan.item.packageName))).toMatchObject({ environment: plan.item.access.environment })
    const raw = await f.database.query<{ configuration: Record<string, unknown> }>(
      'SELECT configuration FROM dsh_phalanx.plugin_access_settings WHERE package_name=$1',
      [plan.item.packageName],
    )
    expect(raw[0]!.configuration).not.toHaveProperty('checkpoint')
    const before = await storage.work.run(async rows => ({ plugin: await rows.plugins.list(), access: await rows.pluginAccess.get(plan.item.packageName) }))
    await unit.install(f.actor, units, options, request)
    expect(await storage.work.run(async rows => ({ plugin: await rows.plugins.list(), access: await rows.pluginAccess.get(plan.item.packageName) }))).toEqual(
      before,
    )
    const next = plugin(2),
      previous = (await storage.installs.get(entry.id))!
    await f.database.query(
      "CREATE TRIGGER reject_plugin AFTER UPDATE ON dsh_phalanx.catalog_installs FOR EACH ROW WHEN (NEW.state='installed') EXECUTE FUNCTION dsh_phalanx.reject_plugin()",
    )
    await expect(
      unit.update(f.actor, { installed: previous, entry: { ...entry, version: '2', items: [next.item] }, runtime: [], skills: [], plugin: next }),
    ).rejects.toMatchObject({ sqlState: '23503' })
    expect(await storage.work.run(async rows => ({ plugin: await rows.plugins.list(), access: await rows.pluginAccess.get(plan.item.packageName) }))).toEqual(
      before,
    )
    expect(await storage.installs.get(entry.id)).toEqual(previous)
    await f.database.query('DROP TRIGGER reject_plugin ON dsh_phalanx.catalog_installs')
    await unit.update(f.actor, { installed: previous, entry: { ...entry, version: '2', items: [next.item] }, runtime: [], skills: [], plugin: next })
    expect((await storage.work.run(rows => rows.plugins.list()))[0]?.version).toBe('2.0.0')
    expect((await storage.work.run(async rows => rows.pluginAccess.get(plan.item.packageName)))?.environment).toEqual(next.item.access.environment)
  } finally {
    await f.close()
  }
})

it('preserves a newer administrator plugin template and its revision during catalog update', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database),
    unit = new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 }, new YamlPluginAccessSyntax())
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
    unit = new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 }, new YamlPluginAccessSyntax())
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
    unit = new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 }, new YamlPluginAccessSyntax())
  try {
    const old = plugin(1),
      next = plugin(2),
      provenance = { maintainer: { username: f.actor.username, spaceId: f.actor.spaceId }, anonymous: true, versions: [] },
      entry = { ...suiteVersion(1), category: 'plugin' as const, id: 'fixture-plugin', version: '2', items: [next.item] },
      options = { id: entry.id, requestId: 'request-plugin-manual-takeover' }
    await storage.work.run(async rows => {
      await rows.plugins.save({
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
