import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { PLATFORM_MIGRATIONS, PLATFORM_SCHEMA_VERSION, platformCoreSchema } from '../src/adapters/platform-schema.js'
import { FilePlatformSecrets } from '../src/adapters/platform-secrets.js'
import { postgresConnection } from './support/postgres.js'

it('initializes its versioned platform schema on real PostgreSQL and opens it again with the matching master key', async () => {
  const connection = postgresConnection(),
    root = mkdtempSync(join(tmpdir(), 'platform-database-'))
  const masterKeyPath = join(root, 'master.key'),
    secrets = FilePlatformSecrets.create(masterKeyPath),
    registry = secrets.registry()
  secrets.close()
  const database = new PlatformDatabase(connection, { masterKeyPath, registry })
  try {
    await database.initialize()
    expect(await database.health()).toMatchObject({ state: 'connected', schemaVersion: PLATFORM_SCHEMA_VERSION })
    expect(await database.query<{ answer: number }>('SELECT 42::integer AS answer')).toEqual([{ answer: 42 }])
    await database.close()
    const reopened = new PlatformDatabase(connection, { masterKeyPath, registry })
    try {
      await reopened.initialize()
      expect(await reopened.health()).toMatchObject({ state: 'connected', schemaVersion: PLATFORM_SCHEMA_VERSION })
    } finally {
      await reopened.close()
    }
  } finally {
    await database.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('commits a transaction together and rolls back every write when its operation fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-transaction-')),
    masterKeyPath = join(root, 'master.key')
  const secrets = FilePlatformSecrets.create(masterKeyPath),
    registry = secrets.registry()
  secrets.close()
  const database = new PlatformDatabase(postgresConnection(), { masterKeyPath, registry })
  try {
    await database.initialize()
    await database.query('CREATE TABLE dsh_phalanx.transaction_probe(value integer NOT NULL)')
    await expect(
      database.transaction(async sql => {
        await sql.query('INSERT INTO dsh_phalanx.transaction_probe(value) VALUES($1)', [17])
        throw Error('fixture refusal')
      }),
    ).rejects.toThrow('fixture refusal')
    expect(await database.query('SELECT value FROM dsh_phalanx.transaction_probe')).toEqual([])
    await database.transaction(async sql => {
      await sql.query('INSERT INTO dsh_phalanx.transaction_probe(value) VALUES($1)', [42])
    })
    expect(await database.query('SELECT value FROM dsh_phalanx.transaction_probe')).toEqual([{ value: 42 }])
  } finally {
    await database.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('leaves the registered master key unchanged when another key tries to open an existing platform database', async () => {
  const connection = postgresConnection(),
    root = mkdtempSync(join(tmpdir(), 'platform-database-key-'))
  const firstPath = join(root, 'first.key'),
    secondPath = join(root, 'second.key')
  const first = FilePlatformSecrets.create(firstPath),
    second = FilePlatformSecrets.create(secondPath)
  const original = { masterKeyPath: firstPath, registry: first.registry() },
    other = { masterKeyPath: secondPath, registry: second.registry() }
  first.close()
  second.close()
  const database = new PlatformDatabase(connection, original),
    wrong = new PlatformDatabase(connection, other)
  try {
    await database.initialize()
    await database.close()
    await expect(wrong.initialize()).rejects.toThrow('fingerprint does not match')
    const restored = new PlatformDatabase(connection, original)
    try {
      await restored.initialize()
      expect(await restored.health()).toMatchObject({ state: 'connected', schemaVersion: PLATFORM_SCHEMA_VERSION })
    } finally {
      await restored.close()
    }
  } finally {
    await Promise.all([database.close(), wrong.close()])
    rmSync(root, { recursive: true, force: true })
  }
})

it('lists migrations contiguously from 1 and derives the supported version from the last one', () => {
  expect(PLATFORM_MIGRATIONS.map(migration => migration.version)).toEqual(PLATFORM_MIGRATIONS.map((_, index) => index + 1))
  expect(PLATFORM_SCHEMA_VERSION).toBe(PLATFORM_MIGRATIONS.length)
  expect(new Set(PLATFORM_MIGRATIONS.map(migration => migration.name)).size).toBe(PLATFORM_MIGRATIONS.length)
})

it('applies only the later migrations to a database prepared at an earlier version', async () => {
  const connection = postgresConnection(),
    root = mkdtempSync(join(tmpdir(), 'platform-partial-schema-')),
    masterKeyPath = join(root, 'master.key')
  const secrets = FilePlatformSecrets.create(masterKeyPath),
    security = { masterKeyPath, registry: secrets.registry() }
  secrets.close()
  const database = new PlatformDatabase(connection, security),
    resumed = new PlatformDatabase(connection, security)
  try {
    await database.initialize()
    // Reconstruct the frozen predecessor DDL; later migrations may replace old tables or alter existing columns.
    await database.query('DROP SCHEMA dsh_phalanx CASCADE')
    await database.query(platformCoreSchema)
    for (const migration of PLATFORM_MIGRATIONS.filter(row => row.version <= 5)) {
      if (migration.sql) await database.query(migration.sql)
      await database.query('INSERT INTO dsh_phalanx.schema_migrations(version) VALUES($1)', [migration.version])
    }
    await database.query('INSERT INTO dsh_phalanx.platform_security(id,registry) VALUES(1,$1)', [JSON.stringify(security.registry)])
    await database.query('UPDATE dsh_phalanx.usage_settings SET retention_days=9 WHERE id=1')
    await database.close()
    await resumed.initialize()
    expect((await resumed.query<{ version: number }>('SELECT version FROM dsh_phalanx.schema_migrations ORDER BY version')).map(row => row.version)).toEqual(
      PLATFORM_MIGRATIONS.map(migration => migration.version),
    )
    expect(await resumed.query("SELECT to_regclass('dsh_phalanx.master_key_backups') IS NOT NULL AS present")).toEqual([{ present: true }])
    expect((await resumed.query('SELECT retention_days FROM dsh_phalanx.usage_settings WHERE id=1'))[0]!.retention_days).toBe(9)
  } finally {
    await resumed.close()
    await database.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses a future schema without changing its version or existing platform data', async () => {
  const connection = postgresConnection(),
    root = mkdtempSync(join(tmpdir(), 'platform-future-schema-')),
    masterKeyPath = join(root, 'master.key')
  const secrets = FilePlatformSecrets.create(masterKeyPath),
    security = { masterKeyPath, registry: secrets.registry() }
  secrets.close()
  const database = new PlatformDatabase(connection, security),
    future = new PlatformDatabase(connection, security)
  try {
    await database.initialize()
    await database.query('UPDATE dsh_phalanx.usage_settings SET retention_days=7 WHERE id=1')
    await database.query('INSERT INTO dsh_phalanx.schema_migrations(version) VALUES(99)')
    await expect(future.initialize()).rejects.toThrow('Unsupported platform database schema version')
    expect((await database.query('SELECT max(version) AS version FROM dsh_phalanx.schema_migrations'))[0]!.version).toBe(99)
    expect((await database.query('SELECT retention_days FROM dsh_phalanx.usage_settings WHERE id=1'))[0]!.retention_days).toBe(7)
  } finally {
    await future.close()
    await database.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('holds one deployment session across transactions, permits operator connections, and releases it on shutdown', async () => {
  const connection = postgresConnection(),
    root = mkdtempSync(join(tmpdir(), 'platform-deployment-')),
    masterKeyPath = join(root, 'master.key')
  const secrets = FilePlatformSecrets.create(masterKeyPath),
    security = { masterKeyPath, registry: secrets.registry() }
  secrets.close()
  const first = new PlatformDatabase(connection, security),
    second = new PlatformDatabase(connection, security),
    operator = new PlatformDatabase(connection, security)
  try {
    await first.claimDeployment('fictional-deployment', () => {})
    await first.initialize()
    await operator.initialize()
    expect(await operator.query('SELECT 42::integer AS answer')).toEqual([{ answer: 42 }])
    await expect(second.claimDeployment('fictional-deployment', () => {})).rejects.toMatchObject({ code: 'deployment-in-use' })
    await first.transaction(async sql => {
      await sql.query('SELECT 1')
    })
    await expect(second.claimDeployment('fictional-other-deployment', () => {})).rejects.toMatchObject({ code: 'deployment-in-use' })
    await first.close()
    await expect(second.claimDeployment('fictional-deployment', () => {})).resolves.toBeUndefined()
  } finally {
    await Promise.all([first.close(), second.close(), operator.close()])
    rmSync(root, { recursive: true, force: true })
  }
})

it('registers its deployment identity and refuses another identity without leaving a startup lock behind', async () => {
  const connection = postgresConnection(),
    root = mkdtempSync(join(tmpdir(), 'platform-identity-')),
    masterKeyPath = join(root, 'master.key')
  const secrets = FilePlatformSecrets.create(masterKeyPath),
    security = { masterKeyPath, registry: secrets.registry() }
  secrets.close()
  const first = new PlatformDatabase(connection, security),
    wrong = new PlatformDatabase(connection, security),
    restored = new PlatformDatabase(connection, security)
  try {
    await first.claimDeployment('fictional-deployment', () => {})
    await first.initialize()
    await first.close()
    await wrong.claimDeployment('fictional-different-deployment', () => {})
    await expect(wrong.initialize()).rejects.toMatchObject({ code: 'deployment-mismatch' })
    await expect(restored.claimDeployment('fictional-deployment', () => {})).resolves.toBeUndefined()
    await restored.initialize()
    expect(await restored.health()).toMatchObject({ state: 'connected' })
  } finally {
    await Promise.all([first.close(), wrong.close(), restored.close()])
    rmSync(root, { recursive: true, force: true })
  }
})

it('makes its production database unavailable when the lock-owning backend disappears', async () => {
  const connection = postgresConnection(),
    root = mkdtempSync(join(tmpdir(), 'platform-lock-loss-')),
    masterKeyPath = join(root, 'master.key')
  const secrets = FilePlatformSecrets.create(masterKeyPath),
    security = { masterKeyPath, registry: secrets.registry() }
  secrets.close()
  const first = new PlatformDatabase(connection, security),
    operator = new PlatformDatabase(connection, security)
  let notify!: () => void
  const lost = new Promise<void>(resolve => {
    notify = resolve
  })
  try {
    await first.claimDeployment('fictional-deployment', notify)
    await first.initialize()
    await operator.initialize()
    const [owner] = await operator.query<{ pid: number }>(
      "SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=1685282900 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
    )
    expect(owner).toBeDefined()
    await operator.query('SELECT pg_terminate_backend($1)', [owner!.pid])
    await lost
    expect(await first.health()).toMatchObject({ state: 'unavailable' })
    await expect(first.query('SELECT 1')).rejects.toMatchObject({ code: 'unavailable' })
  } finally {
    await Promise.all([first.close(), operator.close()])
    rmSync(root, { recursive: true, force: true })
  }
})

it('rolls back a transaction that was accepted before its production ownership session was lost', async () => {
  const connection = postgresConnection(),
    root = mkdtempSync(join(tmpdir(), 'platform-fenced-write-')),
    masterKeyPath = join(root, 'master.key')
  const secrets = FilePlatformSecrets.create(masterKeyPath),
    security = { masterKeyPath, registry: secrets.registry() }
  secrets.close()
  const first = new PlatformDatabase(connection, security),
    operator = new PlatformDatabase(connection, security)
  let notify!: () => void, entered!: () => void, release!: () => void
  const lost = new Promise<void>(resolve => {
      notify = resolve
    }),
    began = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  try {
    await first.claimDeployment('fictional-deployment', notify)
    await first.initialize()
    await operator.initialize()
    await operator.query('CREATE TABLE dsh_phalanx.fenced_probe(value integer)')
    const writing = first.transaction(async sql => {
      await sql.query('INSERT INTO dsh_phalanx.fenced_probe VALUES(42)')
      entered()
      await gate
    })
    const refused = expect(writing).rejects.toMatchObject({ code: 'unavailable' })
    await began
    const [owner] = await operator.query<{ pid: number }>(
      "SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=1685282900 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
    )
    await operator.query('SELECT pg_terminate_backend($1)', [owner!.pid])
    await lost
    release()
    await refused
    expect(await operator.query('SELECT value FROM dsh_phalanx.fenced_probe')).toEqual([])
  } finally {
    release?.()
    await Promise.all([first.close(), operator.close()])
    rmSync(root, { recursive: true, force: true })
  }
})

it('rechecks schema ownership under the migration lock and preserves an unrelated function without creating business tables', async () => {
  const connection = postgresConnection(),
    root = mkdtempSync(join(tmpdir(), 'platform-schema-recheck-')),
    masterKeyPath = join(root, 'master.key')
  const secrets = FilePlatformSecrets.create(masterKeyPath),
    security = { masterKeyPath, registry: secrets.registry() }
  secrets.close()
  const observer = new Pool({ ...connection, user: connection.username }),
    database = new PlatformDatabase(connection, security)
  try {
    await observer.query("CREATE SCHEMA dsh_phalanx; CREATE FUNCTION dsh_phalanx.other_product() RETURNS integer LANGUAGE SQL AS 'SELECT 42'")
    await expect(database.initialize()).rejects.toMatchObject({ code: 'schema-incompatible' })
    expect((await observer.query("SELECT to_regclass('dsh_phalanx.schema_migrations') AS migrations,dsh_phalanx.other_product() AS answer")).rows).toEqual([
      { migrations: null, answer: 42 },
    ])
  } finally {
    await database.close()
    await observer.end()
    rmSync(root, { recursive: true, force: true })
  }
})

it('preserves old protected plugin facts when a fresh-install-only parent migration refuses orphan rows', async () => {
  const connection = postgresConnection(),
    root = mkdtempSync(join(tmpdir(), 'platform-plugin-orphans-')),
    masterKeyPath = join(root, 'master.key')
  const secrets = FilePlatformSecrets.create(masterKeyPath),
    security = { masterKeyPath, registry: secrets.registry() }
  secrets.close()
  const database = new PlatformDatabase(connection, security),
    resumed = new PlatformDatabase(connection, security)
  try {
    await database.initialize()
    // Freeze the actual pre-plugin schema, independent of migrations added afterwards.
    await database.query('DROP SCHEMA dsh_phalanx CASCADE')
    await database.query(platformCoreSchema)
    for (const migration of PLATFORM_MIGRATIONS.filter(row => row.version < 9)) {
      if (migration.sql) await database.query(migration.sql)
      await database.query('INSERT INTO dsh_phalanx.schema_migrations(version) VALUES($1)', [migration.version])
    }
    await database.query('INSERT INTO dsh_phalanx.platform_security(id,registry) VALUES(1,$1)', [JSON.stringify(security.registry)])
    await database.query(`INSERT INTO dsh_phalanx.plugin_access_settings(package_name,configuration,fields,commit_version) VALUES('legacy','{}','[]',0)`)
    await database.query(`INSERT INTO dsh_phalanx.plugin_upstream_settings(package_name,configuration,revision) VALUES('legacy','[]','none')`)
    await expect(resumed.initialize()).rejects.toMatchObject({ code: '23503' })
    expect(await database.query('SELECT package_name FROM dsh_phalanx.plugin_access_settings')).toEqual([{ package_name: 'legacy' }])
    expect(await database.query('SELECT package_name FROM dsh_phalanx.plugin_upstream_settings')).toEqual([{ package_name: 'legacy' }])
    expect(await database.query("SELECT to_regclass('dsh_phalanx.plugin_library') AS table")).toEqual([{ table: null }])
  } finally {
    await Promise.all([database.close(), resumed.close()])
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses predecessor file-backed runtime bindings without discarding their stored names or advancing the schema', async () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-runtime-predecessor-')),
    masterKeyPath = join(root, 'master.key')
  const secrets = FilePlatformSecrets.create(masterKeyPath),
    security = { masterKeyPath, registry: secrets.registry() }
  secrets.close()
  const connection = postgresConnection(),
    database = new PlatformDatabase(connection, security)
  const resumed = new PlatformDatabase(connection, security)
  try {
    await database.initialize()
    await database.query('DROP SCHEMA dsh_phalanx CASCADE')
    await database.query(platformCoreSchema)
    for (const migration of PLATFORM_MIGRATIONS.filter(row => row.version <= 10)) {
      if (migration.sql) await database.query(migration.sql)
      await database.query('INSERT INTO dsh_phalanx.schema_migrations(version) VALUES($1)', [migration.version])
    }
    await database.query('INSERT INTO dsh_phalanx.platform_security(id,registry) VALUES(1,$1)', [JSON.stringify(security.registry)])
    await database.query(`INSERT INTO dsh_phalanx.skills(name,description,hash,imported_at,published,runtime_dependencies)
      VALUES('legacy','','fixture',0,false,'["file-backed-tools"]')`)
    await expect(resumed.initialize()).rejects.toThrow(/Fresh installation is required for runtime dependency/u)
    expect(await database.query('SELECT runtime_dependencies FROM dsh_phalanx.skills')).toEqual([{ runtime_dependencies: ['file-backed-tools'] }])
    expect(await database.query('SELECT max(version) AS version FROM dsh_phalanx.schema_migrations')).toEqual([{ version: 10 }])
    expect(await database.query("SELECT to_regclass('dsh_phalanx.runtime_dependencies') AS table")).toEqual([{ table: null }])
    expect(await database.query("SELECT to_regclass('dsh_phalanx.mcp_state') IS NOT NULL AS preserved")).toEqual([{ preserved: true }])
  } finally {
    await Promise.all([database.close(), resumed.close()])
    rmSync(root, { recursive: true, force: true })
  }
})
