import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { PLATFORM_MIGRATIONS, PLATFORM_SCHEMA_VERSION } from '../src/adapters/platform-schema.js'
import { FilePlatformSecrets } from '../src/adapters/platform-secrets.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { PostgresPluginGrants } from '../src/adapters/postgres-plugin-grants.js'
import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { openTestDatabase } from './support/community-application.js'
import { postgresConnection } from './support/postgres.js'

const prepared = (packageName: string) => ({
  packageName,
  version: '1.0.0',
  integrity: 'sha512-fixture',
  artifact: 'artifacts/fixture',
  runtimeRevision: 'fixture',
  title: packageName,
  description: '',
  bundlePatch: '[]',
  dependencies: {},
})

it('clears plugin rows recorded before sources and their plugin relations while keeping other platform facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-source-upgrade-'))
  const masterKeyPath = join(root, 'master.key'),
    key = FilePlatformSecrets.create(masterKeyPath)
  const security = { masterKeyPath, registry: key.registry() },
    connection = postgresConnection()
  key.close()
  // Source cleanup was introduced in migration 18; later migrations must not move this baseline.
  const previousVersion = 17
  const previous = new PlatformDatabase(connection, security, [
    { name: 'dsh_phalanx', migrations: PLATFORM_MIGRATIONS.filter(migration => migration.version <= previousVersion) },
  ])
  const current = new PlatformDatabase(connection, security)
  try {
    await previous.initialize()
    const accounts = new PostgresCommunityAccountStore(previous)
    await accounts.createFirstAdmin({ username: 'admin', password: 'fixture-password', email: '' })
    const member = await accounts.create({ username: 'member', password: 'fixture-password', email: '', groupId: 'default' })
    // Rows written by the previous release carry no source in their configuration.
    for (const name of ['legacy-npm', 'legacy-upload'])
      await previous.query(
        `INSERT INTO dsh_phalanx.plugin_library(package_name,version,stage,published,current,configuration) VALUES($1,'1.0.0','available',true,$2,'{}')`,
        [name, JSON.stringify(prepared(name))],
      )
    await previous.query(
      `INSERT INTO dsh_phalanx.plugin_uploads(package_name,scope,archive,integrity) VALUES('legacy-upload','current','/fixture.tgz','sha512-fixture')`,
    )
    await new PostgresPluginGrants(previous).set('default', ['legacy-npm'])
    await previous.query(`INSERT INTO dsh_phalanx.plugin_choices(space_id,package_name,kind) VALUES($1,'legacy-npm','selected')`, [member.spaceId])
    await previous.query(`INSERT INTO dsh_phalanx.plugin_deliveries(space_id,package_name,version,source) VALUES($1,'legacy-npm','1.0.0','selected')`, [
      member.spaceId,
    ])
    await previous.query(`INSERT INTO dsh_phalanx.plugin_access_settings(package_name,configuration,fields,commit_version) VALUES('legacy-npm','{}','[]',0)`)
    // Catalog-owned rows have no source either: a plugin entry is uninstalled, a suite detaches only its plugin.
    await previous.query(
      `INSERT INTO dsh_phalanx.plugin_library(package_name,version,stage,published,current,configuration,suite_origin) VALUES('catalog-plugin','1.0.0','available',true,$1,'{}','suite:plugin-entry'),('suite-plugin','1.0.0','available',true,$2,'{}','suite:mixed-suite')`,
      [JSON.stringify(prepared('catalog-plugin')), JSON.stringify(prepared('suite-plugin'))],
    )
    const record = (id: string, category: string, entries: object[]) =>
      JSON.stringify({ id, version: '1.0.0', category, status: 'installed', entries, updatedAt: 1, log: '' })
    await previous.query(
      `INSERT INTO dsh_phalanx.catalog_installs(entry_id,state,record,row_revision) VALUES('plugin-entry','installed',$1,'r1'),('mixed-suite','installed',$2,'r2'),('skill-suite','installed',$3,'r3')`,
      [
        record('plugin-entry', 'plugin', [
          { kind: 'plugin', name: 'catalog-plugin' },
          { kind: 'runtime-dependency', name: 'catalog-tool' },
        ]),
        record('mixed-suite', 'suite', [
          { kind: 'plugin', name: 'suite-plugin' },
          { kind: 'skill', name: 'kept-skill' },
        ]),
        record('skill-suite', 'suite', [{ kind: 'skill', name: 'other-skill' }]),
      ],
    )
    expect(await previous.health()).toMatchObject({ schemaVersion: previousVersion })
    await previous.close()

    await current.initialize()
    expect(await current.health()).toMatchObject({ schemaVersion: PLATFORM_SCHEMA_VERSION })
    const store = new PostgresPluginLibraryStore(current)
    expect(await store.list()).toEqual([])
    for (const table of ['plugin_uploads', 'plugin_grants', 'plugin_choices', 'plugin_access_settings'])
      expect(await current.query(`SELECT 1 FROM dsh_phalanx.${table}`), table).toEqual([])
    // As with a library removal, records of copies already delivered to members stay.
    expect(await current.query('SELECT package_name FROM dsh_phalanx.plugin_deliveries')).toEqual([{ package_name: 'legacy-npm' }])
    const installs = await current.query<{ entry_id: string; record: Record<string, unknown>; row_revision: string }>(
      'SELECT entry_id,record,row_revision FROM dsh_phalanx.catalog_installs ORDER BY entry_id',
    )
    expect(installs.map(row => row.entry_id)).toEqual(['mixed-suite', 'plugin-entry', 'skill-suite'])
    expect(installs[1]!.record).toMatchObject({
      status: 'installed',
      entries: [{ kind: 'runtime-dependency', name: 'catalog-tool' }],
      detached: [{ kind: 'plugin', name: 'catalog-plugin' }],
    })
    expect(installs[0]!.record).toMatchObject({
      status: 'installed',
      entries: [{ kind: 'skill', name: 'kept-skill' }],
      detached: [{ kind: 'plugin', name: 'suite-plugin' }],
    })
    expect(installs[0]!.row_revision).not.toBe('r2')
    expect(installs[2]).toMatchObject({ row_revision: 'r3', record: { entries: [{ kind: 'skill', name: 'other-skill' }] } })
    expect(installs[2]!.record).not.toHaveProperty('detached')
    expect((await new PostgresCommunityAccountStore(current).get('member'))?.spaceId).toBe(member.spaceId)
    expect(await new PostgresCommunityAccountStore(current).get('admin')).toMatchObject({ admin: true })

    // A new row records its source and reopens with it.
    await store.save({ packageName: 'fresh', version: '1.0.0', source: { kind: 'npm' }, stage: 'available', current: prepared('fresh'), published: false })
    await store.save({
      packageName: 'from-github',
      version: '1.0.0',
      source: { kind: 'github', repository: 'Owner/Repo' },
      stage: 'available',
      current: { ...prepared('from-github'), sourceCommit: 'b'.repeat(40) },
      published: false,
    })
    expect(await new PostgresPluginLibraryStore(current).list()).toMatchObject([
      { packageName: 'fresh', source: { kind: 'npm' } },
      { packageName: 'from-github', source: { kind: 'github', repository: 'Owner/Repo' }, current: { sourceCommit: 'b'.repeat(40) } },
    ])
  } finally {
    await cleanupOwned(
      () => previous.close(),
      () => current.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('refuses to read or write a stored plugin row whose source is missing or unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-source-strict-'))
  const database = await openTestDatabase(root)
  try {
    const store = new PostgresPluginLibraryStore(database)
    for (const source of [
      undefined,
      { kind: 'github' },
      { kind: 'github', repository: '../escape' },
      { kind: 'github', repository: 'owner/repo', commit: 'a'.repeat(40) },
      { kind: 'npm', registry: 'https://registry.example.test' },
    ]) {
      await expect(store.save({ packageName: 'strict', version: '1.0.0', source, stage: 'failed', current: null, published: false } as never)).rejects.toThrow(
        'Invalid stored plugin source',
      )
      expect(await store.list()).toEqual([])
    }
    await database.query(
      `INSERT INTO dsh_phalanx.plugin_library(package_name,version,stage,published,current,configuration) VALUES('strict','1.0.0','failed',false,NULL,'{"source":{"kind":"github"}}')`,
    )
    await expect(store.list()).rejects.toThrow('Invalid stored plugin source')
  } finally {
    await cleanupOwned(
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
