import { postgresUpgradeRestoreList } from '../src/adapters/postgres-upgrade-connection.js'
import { databaseProgram } from '../scripts/install/database-program.mjs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PostgresUpgradeTools } from '../src/adapters/postgres-upgrade-tools.js'
import { randomUUID } from 'node:crypto'
import { postgresConnection } from './support/postgres.js'
import { execFile } from 'node:child_process'
import { Pool } from 'pg'
import { FilePlatformDatabaseConfig } from '../src/adapters/platform-database-config.js'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, inject } from 'vitest'
import { backupUpgradeDatabase, restoreUpgradeDatabase, inspectUpgradeDatabase, type UpgradeDatabaseTools } from '../src/adapters/platform-upgrade-database.js'
import { openTestDatabase, testDatabaseConfigFile } from './support/community-application.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'

it('sizes only registered schemas and records absent target namespaces without exposing credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-database-'))
  const database = await openTestDatabase(root)
  try {
    await database.query(`CREATE SCHEMA isolated_probe;
      CREATE TABLE isolated_probe.schema_migrations(version integer PRIMARY KEY);
      INSERT INTO isolated_probe.schema_migrations VALUES(1);
      CREATE TABLE isolated_probe.retained(value text);
      INSERT INTO isolated_probe.retained VALUES('retained');
      CREATE SCHEMA unrelated; CREATE TABLE unrelated.retained(value text);`)
    const result = await inspectUpgradeDatabase(testDatabaseConfigFile(root), root, ['dsh_phalanx', 'isolated_probe', 'new_namespace'])
    expect(result).toMatchObject({
      serverMajor: 17,
      schemas: [
        { name: 'dsh_phalanx', present: true, version: 15 },
        { name: 'isolated_probe', present: true, version: 1 },
        { name: 'new_namespace', present: false, version: 0 },
      ],
      estimatedBytes: expect.any(Number),
    })
    expect(JSON.stringify(result)).not.toContain('password')
    expect(JSON.stringify(result)).not.toContain('unrelated')
    expect((await database.query("SELECT to_regnamespace('new_namespace')::text AS name"))[0]!.name).toBeNull()
  } finally {
    await cleanupOwned(
      () => database.close(),
      async () => rmSync(root, { recursive: true, force: true }),
    )
  }
})

/** Real PostgreSQL archive tools in the fixture container; only the process boundary differs on macOS. */
function archiveTools(): UpgradeDatabaseTools {
  const fixture = inject('postgres')
  async function run(args: string[], input?: Buffer | string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        fixture.command[0]!,
        [...fixture.command.slice(1), 'exec', '-i', fixture.container, ...args],
        { encoding: 'buffer', env: { ...process.env, ...fixture.environment }, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => (error ? reject(Error('Fixture PostgreSQL tool failed')) : resolve(stdout)),
      )
      child.stdin!.end(input)
    })
  }
  return {
    async dump(connection, schemas, destination) {
      const bytes = await run(['pg_dump', '-U', connection.username, '-d', connection.database, '-Fc', ...schemas.flatMap(name => ['-n', name])])
      writeFileSync(destination, bytes, { mode: 0o600, flag: 'wx' })
    },
    async restore(connection, archive, before, after, retainedSchemas) {
      const input = readFileSync(archive),
        list = await run(['pg_restore', '--list'], input)
      const file = join(archive.substring(0, archive.lastIndexOf('/')), 'restore.list')
      writeFileSync(file, postgresUpgradeRestoreList(list.toString(), retainedSchemas), { mode: 0o600 })
      // The fixture's tools live in another namespace, so transmit the private TOC separately.
      const remoteList = '/tmp/upgrade-list-' + randomUUID()
      await run(['sh', '-c', 'umask 077; cat > "$1"', 'fixture', remoteList], readFileSync(file))
      let sql: Buffer
      try {
        sql = await run(['pg_restore', '--use-list=' + remoteList, '--file=-'], input)
      } finally {
        await run(['rm', '--', remoteList])
      }
      await run(
        ['psql', '-X', '--single-transaction', '--set', 'ON_ERROR_STOP=1', '--file=-', '-U', connection.username, '-d', connection.database],
        Buffer.concat([Buffer.from(before + '\n'), sql, Buffer.from('\n' + after)]),
      )
    },
  }
}
it('restores all registered schema rows and versions, removes committed new objects and preserves unrelated schemas', async () => {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-archive-')),
    archive = join(root, 'archive')
  const database = await openTestDatabase(root)
  const configFile = testDatabaseConfigFile(root),
    connection = FilePlatformDatabaseConfig.open(configFile, root).connection
  const pool = new Pool({ ...connection, user: connection.username })
  mkdirSync(archive, { mode: 0o700 })
  try {
    await database.query(`CREATE SCHEMA isolated_probe;
      CREATE TABLE isolated_probe.schema_migrations(version integer PRIMARY KEY);
      INSERT INTO isolated_probe.schema_migrations VALUES(1);
      CREATE TABLE isolated_probe.retained(id integer PRIMARY KEY,value text);
      INSERT INTO isolated_probe.retained VALUES(1,'original');
      CREATE SCHEMA empty_probe; CREATE SCHEMA unrelated; CREATE TABLE unrelated.retained(value text); INSERT INTO unrelated.retained VALUES('outside');`)
    await database.close()
    const facts = await inspectUpgradeDatabase(configFile, root, ['dsh_phalanx', 'isolated_probe', 'empty_probe', 'new_namespace'])
    const receipt = await backupUpgradeDatabase(configFile, root, facts, archive, archiveTools())
    await pool.query(`UPDATE isolated_probe.retained SET value='changed'; INSERT INTO isolated_probe.schema_migrations VALUES(2);
      CREATE TABLE isolated_probe.new_table(id integer);
      CREATE VIEW isolated_probe.new_view AS SELECT * FROM isolated_probe.new_table;
      CREATE TYPE isolated_probe.new_type AS ENUM('new');
      CREATE SCHEMA new_namespace; CREATE TABLE new_namespace.new_table(id integer);
      DELETE FROM dsh_phalanx.schema_migrations WHERE version=15;`)
    await restoreUpgradeDatabase(configFile, root, receipt, archive, archiveTools())
    expect((await pool.query('SELECT * FROM isolated_probe.retained')).rows).toEqual([{ id: 1, value: 'original' }])
    expect((await pool.query('SELECT version FROM isolated_probe.schema_migrations')).rows).toEqual([{ version: 1 }])
    expect(
      (await pool.query("SELECT to_regclass('isolated_probe.new_table')::text AS value,to_regnamespace('new_namespace')::text AS namespace")).rows,
    ).toEqual([{ value: null, namespace: null }])
    expect((await pool.query('SELECT * FROM unrelated.retained')).rows).toEqual([{ value: 'outside' }])
  } finally {
    await cleanupOwned(
      () => database.close(),
      () => pool.end(),
      async () => rmSync(root, { recursive: true, force: true }),
    )
  }
}, 30_000)

it.each(['foreign-key', 'view-chain'])(
  'refuses recovery across an external %s dependency without changing either namespace',
  async dependency => {
    const root = mkdtempSync(join(tmpdir(), 'upgrade-dependency-')),
      archive = join(root, 'archive')
    const database = await openTestDatabase(root),
      configFile = testDatabaseConfigFile(root)
    const connection = FilePlatformDatabaseConfig.open(configFile, root).connection,
      pool = new Pool({ ...connection, user: connection.username })
    mkdirSync(archive, { mode: 0o700 })
    try {
      await database.query(`CREATE SCHEMA isolated_probe; CREATE TABLE isolated_probe.schema_migrations(version integer PRIMARY KEY);
      INSERT INTO isolated_probe.schema_migrations VALUES(1); CREATE TABLE isolated_probe.retained(id integer PRIMARY KEY); INSERT INTO isolated_probe.retained VALUES(1);
      CREATE SCHEMA unrelated;`)
      await database.close()
      const facts = await inspectUpgradeDatabase(configFile, root, ['dsh_phalanx', 'isolated_probe'])
      const receipt = await backupUpgradeDatabase(configFile, root, facts, archive, archiveTools())
      await pool.query(
        dependency === 'foreign-key'
          ? `CREATE TABLE unrelated.dependent(id integer REFERENCES isolated_probe.retained); INSERT INTO unrelated.dependent VALUES(1)`
          : `CREATE VIEW isolated_probe.internal_view AS SELECT * FROM isolated_probe.retained; CREATE VIEW unrelated.dependent AS SELECT * FROM isolated_probe.internal_view`,
      )
      await expect(restoreUpgradeDatabase(configFile, root, receipt, archive, archiveTools())).rejects.toThrow('Fixture PostgreSQL tool failed')
      expect((await pool.query('SELECT * FROM unrelated.dependent')).rows).toEqual([{ id: 1 }])
      expect((await pool.query('SELECT * FROM isolated_probe.retained')).rows).toEqual([{ id: 1 }])
    } finally {
      await cleanupOwned(
        () => database.close(),
        () => pool.end(),
        async () => rmSync(root, { recursive: true, force: true }),
      )
    }
  },
  30_000,
)

it('rejects an empty schema archive selection before invoking a container or writing an archive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-empty-selection-'))
  try {
    const connection = { host: '127.0.0.1', port: 5432, database: 'fixture', username: 'fixture', password: '', tls: 'disable' as const }
    await expect(
      new PostgresUpgradeTools({ image: 'sha256:' + 'a'.repeat(64), digest: 'sha256:' + 'b'.repeat(64), major: 17 }).dump(
        connection,
        [],
        join(root, 'platform.pgdump'),
      ),
    ).rejects.toThrow('empty registered schema selection')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('preserves a foreign view created by an already admitted transaction while recovery waits for its table lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-concurrent-dependency-')),
    archive = join(root, 'archive')
  const database = await openTestDatabase(root),
    configFile = testDatabaseConfigFile(root)
  const connection = FilePlatformDatabaseConfig.open(configFile, root).connection,
    pool = new Pool({ ...connection, user: connection.username })
  const blocker = await pool.connect()
  mkdirSync(archive, { mode: 0o700 })
  let recovery: Promise<void> | undefined
  try {
    await database.query(`CREATE SCHEMA isolated_probe; CREATE TABLE isolated_probe.schema_migrations(version integer PRIMARY KEY);
      INSERT INTO isolated_probe.schema_migrations VALUES(1); CREATE TABLE isolated_probe.retained(id integer PRIMARY KEY); INSERT INTO isolated_probe.retained VALUES(1);
      CREATE SCHEMA unrelated;`)
    await database.close()
    const facts = await inspectUpgradeDatabase(configFile, root, ['dsh_phalanx', 'isolated_probe'])
    const receipt = await backupUpgradeDatabase(configFile, root, facts, archive, archiveTools())
    await blocker.query('BEGIN; LOCK TABLE isolated_probe.retained IN ACCESS SHARE MODE')
    const tools = archiveTools()
    const delayedTools: UpgradeDatabaseTools = {
      ...tools,
      async restore(...args) {
        // Process startup may outlast a default poll window on a busy or slower host.
        await new Promise(resolve => setTimeout(resolve, 1500))
        await tools.restore(...args)
      },
    }
    recovery = restoreUpgradeDatabase(configFile, root, receipt, archive, delayedTools)
    const outcome = recovery.then(
      () => ({ status: 'resolved' }),
      (error: unknown) => ({ status: 'rejected', error }),
    )
    await expect
      .poll(
        async () =>
          (
            await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_locks
      WHERE relation='isolated_probe.retained'::regclass AND mode='AccessExclusiveLock' AND NOT granted) AS waiting`)
          ).rows[0]!.waiting,
        { timeout: 10_000 },
      )
      .toBe(true)
    await blocker.query('CREATE VIEW unrelated.concurrent AS SELECT * FROM isolated_probe.retained; COMMIT')
    expect(await outcome).toMatchObject({ status: 'rejected', error: expect.objectContaining({ message: 'Fixture PostgreSQL tool failed' }) })
    expect((await pool.query('SELECT * FROM unrelated.concurrent')).rows).toEqual([{ id: 1 }])
    expect((await pool.query('SELECT max(version) AS version FROM dsh_phalanx.schema_migrations')).rows).toEqual([{ version: 15 }])
  } finally {
    await blocker.query('ROLLBACK')
    blocker.release()
    await Promise.allSettled(recovery ? [recovery] : [])
    await cleanupOwned(
      () => database.close(),
      () => pool.end(),
      async () => rmSync(root, { recursive: true, force: true }),
    )
  }
}, 30_000)

it('runs the generated pre-download probe using only the predecessor package connection capabilities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-generated-probe-'))
  const data = join(root, 'data'),
    source = join(root, 'source'),
    adapters = join(source, 'dist/adapters')
  mkdirSync(data, { mode: 0o700 })
  mkdirSync(adapters, { recursive: true, mode: 0o700 })
  const database = await openTestDatabase(data),
    configFile = testDatabaseConfigFile(data)
  try {
    // The predecessor exposes these modules, but has no upgrade adapter, schema registry or version reader.
    for (const [name, exports] of [
      ['platform-database-config', 'FilePlatformDatabaseConfig'],
      ['platform-database-inspection', 'platformDatabasePool'],
      ['platform-schema', 'PLATFORM_MIGRATIONS'],
      ['advisory-locks', 'AdvisoryLock'],
    ])
      writeFileSync(join(adapters, name + '.js'), `export { ${exports} } from ${JSON.stringify(pathToFileURL(resolve('src/adapters/' + name + '.ts')).href)};`)
    const script = join(root, 'probe.mjs')
    writeFileSync(script, await databaseProgram(), { mode: 0o600 })
    const request = JSON.stringify({ action: 'inspect', configFile, dataRoot: data, schemas: ['dsh_phalanx'] })
    const output = await new Promise<string>((accept, reject) => {
      const child = execFile(process.execPath, ['--import', 'tsx', script, source], { encoding: 'utf8' }, (error, stdout) =>
        error ? reject(Error('Generated database probe failed')) : accept(stdout),
      )
      child.stdin!.end(request)
    })
    expect(JSON.parse(output)).toMatchObject({ serverMajor: 17, schemas: [{ name: 'dsh_phalanx', present: true, version: 15 }] })
    expect(output).not.toContain('password')
  } finally {
    await cleanupOwned(
      () => database.close(),
      async () => rmSync(root, { recursive: true, force: true }),
    )
  }
})

it('refuses unrepresentable archive credentials during read-only preparation before trying the database or stopping a deployment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-password-format-')),
    data = join(root, 'data'),
    config = join(root, 'database.json')
  mkdirSync(data, { mode: 0o700 })
  const connection = { host: '127.0.0.1', port: 1, database: 'fixture', username: 'fixture', password: 'line-one\nline-two', tls: 'disable' as const }
  try {
    FilePlatformDatabaseConfig.create(config, join(root, 'master.key'), connection)
    FilePlatformDatabaseConfig.select(config, data, connection, 'external')
    await expect(inspectUpgradeDatabase(config, data, ['dsh_phalanx'])).rejects.toThrow('private password-file format')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('recovers a schema owner without database CREATE while keeping its namespace and custom grants', async () => {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-schema-owner-')),
    data = join(root, 'data'),
    archive = join(root, 'archive'),
    configFile = join(root, 'database.json')
  mkdirSync(data, { mode: 0o700 })
  mkdirSync(archive, { mode: 0o700 })
  const administrator = postgresConnection(),
    role = 'upgrade_' + randomUUID().replaceAll('-', '')
  const admin = new Pool({ ...administrator, user: administrator.username })
  const connection = { ...administrator, username: role, password: 'fixture-role-only' },
    pool = new Pool({ ...connection, user: role })
  try {
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'fixture-role-only'; REVOKE CREATE ON DATABASE "${administrator.database}" FROM PUBLIC;
      CREATE SCHEMA dsh_phalanx AUTHORIZATION ${role}; SET ROLE ${role};
      CREATE TABLE dsh_phalanx.schema_migrations(version integer PRIMARY KEY); INSERT INTO dsh_phalanx.schema_migrations VALUES(1);
      CREATE TABLE dsh_phalanx.retained(id integer PRIMARY KEY,value text); INSERT INTO dsh_phalanx.retained VALUES(1,'before');
      GRANT USAGE ON SCHEMA dsh_phalanx TO PUBLIC; COMMENT ON SCHEMA dsh_phalanx IS 'Retained schema metadata'; RESET ROLE;`)
    expect((await pool.query("SELECT has_database_privilege(current_user,current_database(),'CREATE') AS allowed")).rows).toEqual([{ allowed: false }])
    FilePlatformDatabaseConfig.create(configFile, join(root, 'master.key'), connection)
    FilePlatformDatabaseConfig.select(configFile, data, connection, 'external')
    const facts = await inspectUpgradeDatabase(configFile, data, ['dsh_phalanx'])
    const original = (
      await pool.query(
        "SELECT oid::text AS oid,nspowner::text AS owner,nspacl::text AS acl,obj_description(oid,'pg_namespace') AS comment FROM pg_namespace WHERE nspname='dsh_phalanx'",
      )
    ).rows
    const receipt = await backupUpgradeDatabase(configFile, data, facts, archive, archiveTools())
    await pool.query("UPDATE dsh_phalanx.retained SET value='changed'; CREATE TABLE dsh_phalanx.new_table(value text)")
    await restoreUpgradeDatabase(configFile, data, receipt, archive, archiveTools())
    expect((await pool.query('SELECT * FROM dsh_phalanx.retained')).rows).toEqual([{ id: 1, value: 'before' }])
    expect(
      (
        await pool.query(
          "SELECT oid::text AS oid,nspowner::text AS owner,nspacl::text AS acl,obj_description(oid,'pg_namespace') AS comment FROM pg_namespace WHERE nspname='dsh_phalanx'",
        )
      ).rows,
    ).toEqual(original)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS dsh_phalanx CASCADE; DROP ROLE IF EXISTS ${role}`)
    await admin.end()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

it('accepts actual Podman config IDs while refusing mutable image references', () => {
  const raw = 'a'.repeat(64),
    digest = 'sha256:' + 'b'.repeat(64)
  expect(() => new PostgresUpgradeTools({ image: raw, digest, major: 17 })).not.toThrow()
  expect(() => new PostgresUpgradeTools({ image: 'sha256:' + raw, digest, major: 17 })).not.toThrow()
  expect(() => new PostgresUpgradeTools({ image: 'docker.io/library/postgres:17-bookworm', digest, major: 17 })).toThrow()
})
