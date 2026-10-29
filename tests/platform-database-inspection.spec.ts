import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { FilePlatformSecrets } from '../src/adapters/platform-secrets.js'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { inspectPlatformDatabase } from '../src/adapters/platform-database-inspection.js'
import { postgresConnection } from './support/postgres.js'

it('tests an empty external PostgreSQL without creating platform schema or business records', async () => {
  const connection = postgresConnection(),
    observer = new Pool({ ...connection, user: connection.username })
  try {
    const result = await inspectPlatformDatabase(connection, 'sha256:fixture-master-fingerprint')
    expect(result).toMatchObject({
      ok: true,
      schema: 'empty',
      checks: [
        { stage: 'connection', passed: true },
        { stage: 'version', passed: true },
        { stage: 'owner', passed: true },
        { stage: 'schema', passed: true },
      ],
    })
    expect((await observer.query("SELECT to_regnamespace('dsh_phalanx') AS schema")).rows).toEqual([{ schema: null }])
  } finally {
    await observer.end()
  }
})

it('refuses a nonempty schema containing an unrelated function without changing that object', async () => {
  const connection = postgresConnection(),
    observer = new Pool({ ...connection, user: connection.username })
  try {
    await observer.query("CREATE SCHEMA dsh_phalanx; CREATE FUNCTION dsh_phalanx.other_product() RETURNS integer LANGUAGE SQL AS 'SELECT 42'")
    expect(await inspectPlatformDatabase(connection, 'sha256:fixture-master-fingerprint')).toMatchObject({
      ok: false,
      checks: [
        { stage: 'connection', passed: true },
        { stage: 'version', passed: true },
        { stage: 'owner', passed: true },
        { stage: 'schema', passed: false },
      ],
    })
    expect((await observer.query('SELECT dsh_phalanx.other_product() AS answer')).rows).toEqual([{ answer: 42 }])
  } finally {
    await observer.end()
  }
})

it('accepts this platform schema but refuses an unrelated table added alongside its metadata', async () => {
  const connection = postgresConnection(),
    root = mkdtempSync(join(tmpdir(), 'inspection-platform-'))
  const masterKeyPath = join(root, 'master.key'),
    secrets = FilePlatformSecrets.create(masterKeyPath),
    registry = secrets.registry()
  secrets.close()
  const database = new PlatformDatabase(connection, { masterKeyPath, registry })
  try {
    await database.initialize()
    expect(await inspectPlatformDatabase(connection, registry.masterFingerprint)).toMatchObject({ ok: true, schema: 'platform' })
    await database.query('CREATE TABLE dsh_phalanx.other_product(id integer)')
    expect(await inspectPlatformDatabase(connection, registry.masterFingerprint)).toMatchObject({
      ok: false,
      checks: [
        { stage: 'connection', passed: true },
        { stage: 'version', passed: true },
        { stage: 'owner', passed: true },
        { stage: 'schema', passed: false },
      ],
    })
    expect(await database.query('SELECT * FROM dsh_phalanx.other_product')).toEqual([])
  } finally {
    await database.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('reports ownership failure for an account that does not own the selected schema', async () => {
  const connection = postgresConnection(),
    observer = new Pool({ ...connection, user: connection.username })
  const role = 'inspection_' + randomUUID().replaceAll('-', '')
  try {
    await observer.query('CREATE SCHEMA dsh_phalanx')
    await observer.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'fictional-inspection-password'`)
    expect(
      await inspectPlatformDatabase({ ...connection, username: role, password: 'fictional-inspection-password' }, 'sha256:fixture-master-fingerprint'),
    ).toMatchObject({
      ok: false,
      checks: [
        { stage: 'connection', passed: true },
        { stage: 'version', passed: true },
        { stage: 'owner', passed: false },
      ],
    })
    expect(
      (await observer.query("SELECT count(*)::integer AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='dsh_phalanx'"))
        .rows,
    ).toEqual([{ count: 0 }])
  } finally {
    await observer.query(`DROP ROLE IF EXISTS "${role}"`)
    await observer.end()
  }
})

it.each([
  [
    'standalone composite type',
    'CREATE TYPE dsh_phalanx.foreign_object AS (value integer)',
    "SELECT oid FROM pg_type WHERE typnamespace='dsh_phalanx'::regnamespace AND typname='foreign_object'",
  ],
  [
    'collation',
    'CREATE COLLATION dsh_phalanx.foreign_object FROM pg_catalog."C"',
    "SELECT oid FROM pg_collation WHERE collnamespace='dsh_phalanx'::regnamespace AND collname='foreign_object'",
  ],
  [
    'range type',
    'CREATE TYPE dsh_phalanx.foreign_object AS RANGE(subtype=integer)',
    "SELECT oid FROM pg_type WHERE typnamespace='dsh_phalanx'::regnamespace AND typname='foreign_object'",
  ],
  [
    'text search configuration',
    'CREATE TEXT SEARCH CONFIGURATION dsh_phalanx.foreign_object (COPY=pg_catalog.simple)',
    "SELECT oid FROM pg_ts_config WHERE cfgnamespace='dsh_phalanx'::regnamespace AND cfgname='foreign_object'",
  ],
])('refuses a foreign %s both in the read-only probe and under the migration lock', async (_kind, create, proof) => {
  const connection = postgresConnection(),
    observer = new Pool({ ...connection, user: connection.username })
  const root = mkdtempSync(join(tmpdir(), 'inspection-foreign-object-')),
    masterKeyPath = join(root, 'master.key')
  const secrets = FilePlatformSecrets.create(masterKeyPath),
    registry = secrets.registry()
  secrets.close()
  const database = new PlatformDatabase(connection, { masterKeyPath, registry })
  try {
    await observer.query('CREATE SCHEMA dsh_phalanx')
    await observer.query(create)
    const original = (await observer.query(proof)).rows
    expect(original).toHaveLength(1)
    expect(await inspectPlatformDatabase(connection, registry.masterFingerprint)).toMatchObject({
      ok: false,
      checks: [
        { stage: 'connection', passed: true },
        { stage: 'version', passed: true },
        { stage: 'owner', passed: true },
        { stage: 'schema', passed: false },
      ],
    })
    await expect(database.initialize()).rejects.toMatchObject({ code: 'schema-incompatible' })
    expect((await observer.query(proof)).rows).toEqual(original)
    expect((await observer.query("SELECT to_regclass('dsh_phalanx.schema_migrations') AS migrations")).rows).toEqual([{ migrations: null }])
  } finally {
    await database.close()
    await observer.end()
    rmSync(root, { recursive: true, force: true })
  }
})
