import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect } from 'vitest'
import { execFileText } from '../../src/adapters/runtime-command.js'

/** Installed adapters and real TLS PG tools; isolated migrations exist only in this test composition. */
export async function assertInstalledExternalUpgrade(installed: string, root: string, configFile: string, data: string) {
  const load = (name: string) => import(pathToFileURL(join(installed, 'dist/adapters', name + '.js')).href)
  const { FilePlatformDatabaseConfig: Saved } = (await load('platform-database-config')) as typeof import('../../src/adapters/platform-database-config.js')
  const { PlatformDatabase } = (await load('platform-database')) as typeof import('../../src/adapters/platform-database.js')
  const { PLATFORM_SCHEMAS } = (await load('platform-schema-registry')) as typeof import('../../src/adapters/platform-schema-registry.js')
  const { platformDatabasePool } = (await load('platform-database-inspection')) as typeof import('../../src/adapters/platform-database-inspection.js')
  const { inspectUpgradeDatabase, backupUpgradeDatabase, restoreUpgradeDatabase } = (await load(
    'platform-upgrade-database',
  )) as typeof import('../../src/adapters/platform-upgrade-database.js')
  const { PostgresUpgradeTools } = (await load('postgres-upgrade-tools')) as typeof import('../../src/adapters/postgres-upgrade-tools.js')
  const { resolveDownloadSources, downloadSourceSelection } = (await import(
    pathToFileURL(join(installed, 'dist/domain/download-source.js')).href
  )) as typeof import('../../src/domain/download-source.js')
  expect(PLATFORM_SCHEMAS.map(schema => schema.name)).toEqual(['dsh_phalanx'])
  const saved = Saved.open(configFile, data),
    observer = platformDatabasePool(saved.connection)
  expect(saved.selection).toBe('external')
  const first = {
    version: 1,
    name: 'fixture-original',
    sql: `CREATE TABLE upgrade_fixture.retained(id integer PRIMARY KEY,value text);
    INSERT INTO upgrade_fixture.retained VALUES(1,'before')`,
  }
  const second = { version: 2, name: 'fixture-success', sql: `ALTER TABLE upgrade_fixture.retained ADD COLUMN state text NOT NULL DEFAULT 'upgraded'` }
  const migrate = async (migrations: readonly (typeof first)[], newNamespace = false) => {
    const database = new PlatformDatabase(saved.connection, saved.security, [
      ...PLATFORM_SCHEMAS,
      { name: 'upgrade_fixture', migrations },
      ...(newNamespace
        ? [
            {
              name: 'new_upgrade_fixture',
              migrations: [{ version: 1, name: 'fixture-new-namespace', sql: 'CREATE TABLE new_upgrade_fixture.new_table(id integer)' }],
            },
          ]
        : []),
    ])
    try {
      await database.initialize()
    } finally {
      await database.close()
    }
  }
  const archive = join(root, 'upgrade-archive')
  mkdirSync(archive, { mode: 0o700 })
  const key = readFileSync(saved.security.masterKeyPath),
    configuration = readFileSync(configFile)
  try {
    await migrate([first])
    await observer.query(
      "CREATE SCHEMA unrelated_upgrade; CREATE TABLE unrelated_upgrade.keep(value text); INSERT INTO unrelated_upgrade.keep VALUES('outside')",
    )
    const before = await inspectUpgradeDatabase(configFile, data, ['dsh_phalanx', 'upgrade_fixture'])
    const sources = resolveDownloadSources(downloadSourceSelection(JSON.parse(process.env.DSH_PHALANX_DOWNLOAD_SOURCES ?? '{"preset":"official"}')))
    const probeRoot = join(root, 'installed-python-database-tools'),
      probeConfig = join(probeRoot, 'config/database.json'),
      probeData = join(probeRoot, 'data')
    mkdirSync(join(probeRoot, 'config'), { recursive: true, mode: 0o700 })
    mkdirSync(probeData, { mode: 0o700 })
    Saved.create(probeConfig, join(probeRoot, 'config/master.key'), saved.connection)
    Saved.select(probeConfig, probeData, saved.connection, 'external')
    writeFileSync(join(probeRoot, 'request.json'), JSON.stringify({ mirror: sources.containerMirror ?? '' }), { mode: 0o600 })
    const probe = JSON.parse(await execFileText('python3', ['-B', resolve('tests/fixtures/installed-database-tools.py'), installed, probeRoot]))
    expect(probe).toMatchObject({ status: 'passed', serverMajor: before.serverMajor, tool: { major: before.serverMajor } })
    expect(probe.tool.image).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(probe.tool.digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    const tool = probe.tool as ConstructorParameters<typeof PostgresUpgradeTools>[0]
    const tools = new PostgresUpgradeTools(tool)
    const initialArchive = join(archive, 'initial')
    mkdirSync(initialArchive, { mode: 0o700 })
    await backupUpgradeDatabase(configFile, data, before, initialArchive, tools)
    await migrate([first, second])
    expect((await observer.query('SELECT * FROM upgrade_fixture.retained')).rows).toEqual([{ id: 1, value: 'before', state: 'upgraded' }])
    const upgraded = await inspectUpgradeDatabase(configFile, data, ['dsh_phalanx', 'upgrade_fixture', 'new_upgrade_fixture'])
    const recovery = join(archive, 'recovery')
    mkdirSync(recovery, { mode: 0o700 })
    const backup = await backupUpgradeDatabase(configFile, data, upgraded, recovery, tools)
    const failing = { version: 3, name: 'fixture-migration-failure', sql: `UPDATE upgrade_fixture.retained SET value='broken'; SELECT 1/0` }
    await expect(migrate([first, second, failing])).rejects.toThrow()
    await restoreUpgradeDatabase(configFile, data, backup, recovery, tools)
    expect((await observer.query('SELECT * FROM upgrade_fixture.retained')).rows).toEqual([{ id: 1, value: 'before', state: 'upgraded' }])
    // Also cover committed DDL followed by a later validation failure: the archive must remove new objects.
    await migrate(
      [
        first,
        second,
        {
          version: 3,
          name: 'fixture-later-validation-failure',
          sql: `UPDATE upgrade_fixture.retained SET value='committed-change';
      CREATE TABLE upgrade_fixture.new_table(id integer)`,
        },
      ],
      true,
    )
    await restoreUpgradeDatabase(configFile, data, backup, recovery, tools)
    expect((await observer.query('SELECT * FROM upgrade_fixture.retained')).rows).toEqual([{ id: 1, value: 'before', state: 'upgraded' }])
    expect((await observer.query('SELECT max(version) AS version FROM upgrade_fixture.schema_migrations')).rows).toEqual([{ version: 2 }])
    expect(
      (await observer.query("SELECT to_regnamespace('new_upgrade_fixture')::text AS namespace,to_regclass('upgrade_fixture.new_table')::text AS relation"))
        .rows,
    ).toEqual([{ namespace: null, relation: null }])
    expect((await observer.query('SELECT * FROM unrelated_upgrade.keep')).rows).toEqual([{ value: 'outside' }])
    expect(readFileSync(saved.security.masterKeyPath)).toEqual(key)
    expect(readFileSync(configFile)).toEqual(configuration)
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence)
      writeFileSync(
        join(evidence, 'external-upgrade.json'),
        JSON.stringify({
          status: 'passed',
          installedCommit: JSON.parse(readFileSync(join(installed, 'build-info.json'), 'utf8')).commit,
          tool,
          installedPythonPreparation: {
            source: probe.source,
            executorPackageSha256: probe.executorPackageSha256,
            serverMajor: probe.serverMajor,
            estimatedBytes: probe.estimatedBytes,
          },
          serverMajor: before.serverMajor,
          sourceSchemas: before.schemas,
          restoredSchemas: upgraded.schemas,
          successfulMigration: true,
          failedMigrationRestored: true,
          committedSchemaRestored: true,
          keysUnchanged: true,
          unrelatedPreserved: true,
        }) + '\n',
        { mode: 0o600 },
      )
  } finally {
    await observer.end()
    rmSync(archive, { recursive: true, force: true })
  }
}
