import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FilePlatformDatabaseConfig } from '../src/adapters/platform-database-config.js'
import { PostgresCatalogInstalls, PostgresCatalogRequests } from '../src/adapters/postgres-catalog-records.js'
import { PostgresCommunityModelAccess } from '../src/adapters/postgres-community-model-access.js'
import { PostgresSystemStatus } from '../src/adapters/postgres-system-status.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication, openTestDatabase, testDatabaseConfigFile } from './support/community-application.js'
import { seedPlatformSecretFixture } from './support/platform-secret-fixture.js'
import { postgresConnection } from './support/postgres.js'

const execute = promisify(execFile)
async function facts(pool: Pool) {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='dsh_phalanx' ORDER BY tablename")).rows as { tablename: string }[]
  return Object.fromEntries(
    await Promise.all(
      tables.map(async ({ tablename }) => [
        tablename,
        (await pool.query(`SELECT to_jsonb(row)::text AS value FROM dsh_phalanx."${tablename}" AS row ORDER BY to_jsonb(row)::text`)).rows.map(
          row => row.value,
        ),
      ]),
    ),
  )
}
it('switches both ways without changing source facts, member sessions, tokens, identity sequences or unrelated schemas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-database-switch-')),
    data = join(root, 'data'),
    maintenance = join(root, 'maintenance')
  await mkdir(data)
  const configFile = testDatabaseConfigFile(data),
    initial = FilePlatformDatabaseConfig.open(configFile, data),
    external = postgresConnection()
  FilePlatformDatabaseConfig.select(configFile, data, initial.connection, 'builtin')
  const builtinFile = join(dirname(configFile), 'builtin-database.json')
  await copyFile(configFile, builtinFile)
  const originalBuiltin = await readFile(builtinFile),
    originalMaster = await readFile(initial.security.masterKeyPath)
  const source = new Pool({ ...initial.connection, user: initial.connection.username }),
    target = new Pool({ ...external, user: external.username })
  const config = {
    listen: { host: '127.0.0.1', port: 0 },
    platformDatabaseConfigFile: configFile,
    maintenanceFile: maintenance,
    runtime: {
      command: process.execPath,
      args: ['tests/fixtures/runtime.mjs'],
      dataRoot: data,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  }
  let app = createCommunityApplication(config),
    child: ReturnType<typeof spawn> | undefined
  let exited: Promise<void> | undefined
  try {
    const origin = await app.start()
    const initialized = await fetch(origin + '/bootstrap', {
      method: 'POST',
      redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: readBootstrapCredential(data)!.credential, username: 'admin', password: 'password' }),
    })
    expect(initialized.status).toBe(303)
    const cookie = initialized.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
    await app.stop()
    const database = await openTestDatabase(data),
      access = new PostgresCommunityModelAccess(database)
    let token: string
    try {
      const space = (await database.query<{ space_id: string }>("SELECT space_id FROM dsh_phalanx.accounts WHERE username='admin'"))[0]!.space_id
      await access.initialize()
      token = await access.forUser('admin', space)
      await seedPlatformSecretFixture(database, data)
      await new PostgresCatalogInstalls(database).save({
        id: 'retained-catalog',
        version: '1.0.0',
        status: 'failed',
        entries: [],
        requestId: 'retained-request',
        updatedAt: 1,
        log: 'Retained catalog result.',
      })
      await new PostgresCatalogRequests(database).save('retained-request', { id: 'retained-catalog', version: '1.0.0', status: 'failed' })
      await database.query("UPDATE dsh_phalanx.catalog_requests SET position=9007199254740997 WHERE request_id='retained-request'")

      await database.query('INSERT INTO dsh_phalanx.master_key_backups(fingerprint,username,space_id) VALUES($1,$2,$3)', [
        initial.security.registry.masterFingerprint,
        'admin',
        space,
      ])
      await database.query(`INSERT INTO dsh_phalanx.groups VALUES('équipe','Équipe','ordinary',false);
        INSERT INTO dsh_phalanx.accounts SELECT 'member',NULL,password_hash,false,false,2,created_at,updated_at,'member-space','member-storage','équipe' FROM dsh_phalanx.accounts WHERE username='admin';
        INSERT INTO dsh_phalanx.accounts SELECT 'disabled',NULL,password_hash,false,true,3,created_at,updated_at,'disabled-space','disabled-storage','équipe' FROM dsh_phalanx.accounts WHERE username='admin';
        INSERT INTO dsh_phalanx.retired_accounts VALUES('retired',41);
        INSERT INTO dsh_phalanx.usage_model_hours VALUES('member','fixture','équipe',0,9007199254740993,2,3,9007199254740994,5,6,7);
        INSERT INTO dsh_phalanx.usage_reported_days VALUES('member','équipe','fixture',0,7)`)

      await database.query(`INSERT INTO dsh_phalanx.usage_records(id,username,kind,capability,operation,started_at,duration_ms,outcome)
        OVERRIDING SYSTEM VALUE VALUES(9007199254740993,'admin','skill','fixture','run',42,0.125,'succeeded')`)
      await database.query("SELECT setval('dsh_phalanx.usage_records_id_seq',9007199254741000,false)")
    } finally {
      await access.close()
      await database.close()
    }
    await target.query("CREATE SCHEMA retained; CREATE TABLE retained.sentinel(value text); INSERT INTO retained.sentinel VALUES('keep me')")
    const connectionFile = join(dirname(configFile), 'database-target.json')
    const role = 'owner_' + external.database.replace('phalanx_', '')
    await target.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'fictional-switch-password'`)
    expect((await target.query("SELECT has_database_privilege($1,current_database(),'CREATE') AS allowed", [role])).rows[0].allowed).toBe(false)
    await writeFile(connectionFile, JSON.stringify({ ...external, username: role, password: 'fictional-switch-password' }), { mode: 0o600 })
    const before = await facts(source)
    const argumentsFor = (selection: 'builtin' | 'external') => [
      '--import',
      'tsx',
      'src/composition/cli.ts',
      'database-switch',
      '--config-file',
      configFile,
      '--data-root',
      data,
      '--maintenance-file',
      maintenance,
      '--target',
      selection,
      ...(selection === 'external' ? ['--connection-file', connectionFile] : []),
      '--offline',
    ]
    const switchTo = (selection: 'builtin' | 'external') => execute(process.execPath, argumentsFor(selection))
    await target.query(`CREATE SCHEMA dsh_phalanx AUTHORIZATION "${role}"; CREATE TABLE dsh_phalanx.unrelated(value text)`)
    await expect(switchTo('external')).rejects.toMatchObject({ code: 1 })
    await expect(readFile(maintenance)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(FilePlatformDatabaseConfig.open(configFile, data).selection).toBe('builtin')
    await target.query('DROP TABLE dsh_phalanx.unrelated; DROP SCHEMA dsh_phalanx')
    await target.query(`CREATE SCHEMA dsh_phalanx AUTHORIZATION "${role}"`)
    expect(JSON.parse((await switchTo('external')).stdout)).toMatchObject({ status: 'switched', selection: 'external' })
    expect(await facts(source)).toEqual(before)
    expect(await facts(target)).toEqual(before)
    expect(await readFile(builtinFile)).toEqual(originalBuiltin)
    expect(await readFile(initial.security.masterKeyPath)).toEqual(originalMaster)
    expect((await target.query('TABLE retained.sentinel')).rows).toEqual([{ value: 'keep me' }])
    app = createCommunityApplication(config)
    expect((await fetch((await app.start()) + '/admin/api/session', { headers: { cookie } })).status).toBe(200)
    await app.stop()
    const copied = await openTestDatabase(data),
      copiedAccess = new PostgresCommunityModelAccess(copied)
    try {
      await copiedAccess.initialize()
      expect(await copiedAccess.resolve(token!)).toMatchObject({ username: 'admin' })
      expect((await new PostgresSystemStatus(copied, () => 'external').read()).masterKey.backup).toMatchObject({ username: 'admin' })
    } finally {
      await copiedAccess.close()
      await copied.close()
    }
    expect(
      (
        await target.query(
          "INSERT INTO dsh_phalanx.usage_records(username,kind,capability,operation,started_at,duration_ms,outcome) VALUES('admin','skill','fixture','next',43,0.25,'succeeded') RETURNING id::text AS id",
        )
      ).rows[0].id,
    ).toBe('9007199254741000')
    const beforeRotation = await facts(target)
    const rotated = JSON.parse(
      (
        await execute(process.execPath, [
          '--import',
          'tsx',
          'src/composition/cli.ts',
          'master-key-rotate',
          '--config-file',
          configFile,
          '--data-root',
          data,
          '--maintenance-file',
          maintenance,
          '--offline',
        ])
      ).stdout,
    )
    expect(rotated.fingerprint).not.toBe(initial.security.registry.masterFingerprint)
    const afterRotation = await facts(target)
    expect({ ...afterRotation, platform_security: [] }).toEqual({ ...beforeRotation, platform_security: [] })
    expect(FilePlatformDatabaseConfig.open(builtinFile, data).security.registry.masterFingerprint).toBe(rotated.fingerprint)
    app = createCommunityApplication(config)
    expect((await fetch((await app.start()) + '/admin/api/session', { headers: { cookie } })).status).toBe(200)
    await app.stop()
    const rotatedDatabase = await openTestDatabase(data)
    try {
      const status = new PostgresSystemStatus(rotatedDatabase, () => 'external')
      expect((await status.read()).masterKey).toEqual({ fingerprint: rotated.fingerprint, backup: null })
      await expect(status.confirmBackup(initial.security.registry.masterFingerprint, { username: 'admin', spaceId: 'fixture-space' })).rejects.toMatchObject({
        code: 'master-key-changed',
      })
    } finally {
      await rotatedDatabase.close()
    }
    const retained = await facts(source),
      guard = await source.connect()
    try {
      await guard.query('BEGIN')
      await guard.query('LOCK TABLE dsh_phalanx.accounts IN ACCESS SHARE MODE')
      child = spawn(process.execPath, argumentsFor('builtin'), { stdio: 'ignore' })
      exited = new Promise(resolve => child!.once('close', () => resolve()))
      await expect
        .poll(
          async () => {
            if (child!.exitCode !== null) throw Error('The switch exited before its target barrier')
            return (
              await source.query("SELECT pid FROM pg_locks WHERE relation='dsh_phalanx.accounts'::regclass AND mode='AccessExclusiveLock' AND NOT granted")
            ).rowCount
          },
          { timeout: 10_000 },
        )
        .toBe(1)
      const waiting = (
        await source.query("SELECT pid FROM pg_locks WHERE relation='dsh_phalanx.accounts'::regclass AND mode='AccessExclusiveLock' AND NOT granted")
      ).rows[0].pid
      const sourceOwner = (
        await target.query(
          "SELECT pid FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=0 AND objid=1685282900 AND objsubid=1 AND granted",
        )
      ).rows
      expect(sourceOwner).toHaveLength(1)
      child.kill('SIGKILL')
      await exited
      await source.query('SELECT pg_terminate_backend($1)', [waiting])
      await target.query('SELECT pg_terminate_backend($1)', [sourceOwner[0].pid])
    } finally {
      await guard.query('ROLLBACK')
      guard.release()
    }
    expect(await facts(source)).toEqual(retained)
    app = createCommunityApplication(config)
    expect((await fetch((await app.start()) + '/admin/api/session', { headers: { cookie } })).status).toBe(200)
    await app.stop()
    await expect(readFile(maintenance)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(FilePlatformDatabaseConfig.open(configFile, data).selection).toBe('external')
    const reverse = await facts(target)
    await source.query(
      "CREATE SCHEMA retained_incoming; CREATE TABLE retained_incoming.dependent(account text REFERENCES dsh_phalanx.accounts(username)); INSERT INTO retained_incoming.dependent VALUES('admin')",
    )
    await expect(switchTo('builtin')).rejects.toMatchObject({ code: 1 })
    expect(await facts(source)).toEqual(retained)
    expect(await facts(target)).toEqual(reverse)
    expect(FilePlatformDatabaseConfig.open(configFile, data).selection).toBe('external')
    await expect(readFile(maintenance)).rejects.toMatchObject({ code: 'ENOENT' })
    await source.query('DROP TABLE retained_incoming.dependent; DROP SCHEMA retained_incoming')
    expect(JSON.parse((await switchTo('builtin')).stdout)).toMatchObject({ status: 'switched', selection: 'builtin' })
    expect(await facts(source)).toEqual(reverse)
    expect(await facts(target)).toEqual(reverse)
    app = createCommunityApplication(config)
    expect((await fetch((await app.start()) + '/admin/api/session', { headers: { cookie } })).status).toBe(200)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    await app.stop()
    await source.end()
    await target.end()
    await removeCommunityFixture(root)
  }
}, 30000)
