import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { readRegisteredSchemaVersions } from '../src/adapters/platform-database-inspection.js'
import { PLATFORM_SCHEMAS, type PlatformSchema } from '../src/adapters/platform-schema-registry.js'
import { FilePlatformSecrets } from '../src/adapters/platform-secrets.js'
import { postgresConnection } from './support/postgres.js'

it('prepares registered schemas in order with independent versions and leaves unrelated external data alone', async () => {
  const connection = postgresConnection(),
    root = mkdtempSync(join(tmpdir(), 'registered-schemas-')),
    masterKeyPath = join(root, 'master.key'),
    key = FilePlatformSecrets.create(masterKeyPath),
    security = { masterKeyPath, registry: key.registry() },
    sql = new Pool({ ...connection, user: connection.username, ssl: false })
  key.close()
  const schemas: readonly PlatformSchema[] = [
    ...PLATFORM_SCHEMAS,
    {
      name: 'isolated_probe',
      migrations: [
        {
          version: 1,
          name: 'probe',
          sql: 'CREATE TABLE isolated_probe.observed(value integer); INSERT INTO isolated_probe.observed SELECT max(version) FROM dsh_phalanx.schema_migrations;',
        },
        { version: 2, name: 'second', sql: 'INSERT INTO isolated_probe.observed VALUES(42)' },
      ],
    },
  ]
  const production = new PlatformDatabase(connection, security),
    extended = new PlatformDatabase(connection, security, schemas),
    reopened = new PlatformDatabase(connection, security, schemas)
  try {
    await sql.query('CREATE SCHEMA unrelated; CREATE TABLE unrelated.sentinel(value integer); INSERT INTO unrelated.sentinel VALUES(17)')
    await production.initialize()
    expect((await sql.query("SELECT to_regnamespace('isolated_probe')::text AS name")).rows).toEqual([{ name: null }])
    await production.close()
    await extended.initialize()
    expect(await readRegisteredSchemaVersions(sql, schemas)).toEqual([
      { name: 'dsh_phalanx', version: 15 },
      { name: 'isolated_probe', version: 2 },
    ])
    expect(await extended.query('SELECT value FROM isolated_probe.observed ORDER BY value')).toEqual([{ value: 15 }, { value: 42 }])
    expect(await extended.query('SELECT value FROM unrelated.sentinel')).toEqual([{ value: 17 }])
    await extended.close()
    await reopened.initialize()
    expect(await reopened.query('SELECT value FROM isolated_probe.observed ORDER BY value')).toEqual([{ value: 15 }, { value: 42 }])
  } finally {
    await Promise.all([production.close(), extended.close(), reopened.close(), sql.end()])
    rmSync(root, { recursive: true, force: true })
  }
})

it('migrates owned existing schemas without database CREATE and clearly refuses a missing registered schema', async () => {
  const connection = postgresConnection(),
    root = mkdtempSync(join(tmpdir(), 'registered-owner-')),
    masterKeyPath = join(root, 'master.key'),
    key = FilePlatformSecrets.create(masterKeyPath),
    security = { masterKeyPath, registry: key.registry() },
    sql = new Pool({ ...connection, user: connection.username, ssl: false }),
    role = connection.database + '_owner',
    password = 'registry-owner-fixture'
  key.close()
  const extra = { name: 'isolated_probe', migrations: [{ version: 1, name: 'probe', sql: 'CREATE TABLE isolated_probe.observed(value integer)' }] },
    schemas = [...PLATFORM_SCHEMAS, extra],
    restricted = { ...connection, username: role, password },
    database = new PlatformDatabase(restricted, security, schemas),
    missing = new PlatformDatabase(restricted, security, [...schemas, { ...extra, name: 'missing_probe' }])
  try {
    await sql.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'; REVOKE CREATE ON DATABASE "${connection.database}" FROM PUBLIC;
      CREATE SCHEMA dsh_phalanx AUTHORIZATION "${role}"; CREATE SCHEMA isolated_probe AUTHORIZATION "${role}";`)
    await database.initialize()
    expect(await database.health()).toMatchObject({ state: 'connected', schemaVersion: 15 })
    expect(await database.query("SELECT has_database_privilege(current_user,current_database(),'CREATE') AS allowed")).toEqual([{ allowed: false }])
    await expect(missing.initialize()).rejects.toMatchObject({ code: 'schema-incompatible' })
    expect((await sql.query("SELECT to_regnamespace('missing_probe')::text AS name")).rows).toEqual([{ name: null }])
  } finally {
    await Promise.all([database.close(), missing.close()])
    await sql.query(`DROP SCHEMA IF EXISTS dsh_phalanx CASCADE; DROP SCHEMA IF EXISTS isolated_probe CASCADE; DROP ROLE IF EXISTS "${role}"`)
    await sql.end()
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps every table created by the complete production migrations inside the registered inventory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'registered-tables-')),
    masterKeyPath = join(root, 'master.key'),
    key = FilePlatformSecrets.create(masterKeyPath),
    security = { masterKeyPath, registry: key.registry() },
    database = new PlatformDatabase(postgresConnection(), security)
  key.close()
  try {
    await database.initialize()
    const unregisteredTables = async () => {
      const tables = await database.query<{ schema: string; name: string }>(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','f')
        AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY n.nspname,c.relname`)
      return tables.filter(table => !PLATFORM_SCHEMAS.some(schema => schema.name === table.schema))
    }
    expect(await unregisteredTables()).toEqual([])
    // A legal name beginning with pg, without the reserved underscore, must remain visible to the guard.
    await database.query('CREATE SCHEMA pgtenant; CREATE TABLE pgtenant.accidental(value integer)')
    expect(await unregisteredTables()).toEqual([{ schema: 'pgtenant', name: 'accidental' }])
  } finally {
    await database.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('rolls back preparation of every registered schema when a later migration fails', async () => {
  const connection = postgresConnection(),
    root = mkdtempSync(join(tmpdir(), 'registered-rollback-')),
    masterKeyPath = join(root, 'master.key'),
    key = FilePlatformSecrets.create(masterKeyPath),
    security = { masterKeyPath, registry: key.registry() },
    sql = new Pool({ ...connection, user: connection.username, ssl: false }),
    schemas = [
      ...PLATFORM_SCHEMAS,
      {
        name: 'isolated_probe',
        migrations: [
          { version: 1, name: 'first', sql: 'CREATE TABLE isolated_probe.observed(value integer)' },
          { version: 2, name: 'refused', sql: 'INSERT INTO isolated_probe.observed(unknown_column) VALUES(42)' },
        ],
      },
    ],
    database = new PlatformDatabase(connection, security, schemas)
  key.close()
  try {
    await expect(database.initialize()).rejects.toMatchObject({ name: 'PlatformMigrationError', code: '42703' })
    expect(await readRegisteredSchemaVersions(sql, schemas)).toEqual([
      { name: 'dsh_phalanx', version: 0 },
      { name: 'isolated_probe', version: 0 },
    ])
    expect((await sql.query("SELECT nspname FROM pg_namespace WHERE nspname IN ('dsh_phalanx','isolated_probe')")).rows).toEqual([])
    const interrupted = new PlatformDatabase(connection, security, [
      ...PLATFORM_SCHEMAS,
      { name: 'isolated_probe', migrations: [{ version: 1, name: 'disconnect', sql: 'SELECT pg_terminate_backend(pg_backend_pid())' }] },
    ])
    try {
      await expect(interrupted.initialize()).rejects.toMatchObject({ name: 'PlatformDatabaseError', code: 'unavailable', sqlState: '57P01' })
    } finally {
      await interrupted.close()
    }
  } finally {
    await Promise.all([database.close(), sql.end()])
    rmSync(root, { recursive: true, force: true })
  }
})
