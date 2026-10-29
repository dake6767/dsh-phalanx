import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { writeBuiltinDatabasePassword } from '../src/adapters/builtin-database-setup.js'
import { FilePlatformDatabaseConfig } from '../src/adapters/platform-database-config.js'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { postgresConnection } from './support/postgres.js'

it.each(['rotate', 'reset'] as const)('recovers a killed %s before the built-in password hook and completes both registries before serving', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'platform-key-recovery-')),
    data = join(root, 'data'),
    keys = join(root, 'keys')
  await mkdir(data)
  await mkdir(keys, { mode: 0o700 })
  const configFile = join(keys, 'database.json'),
    builtinFile = join(keys, 'builtin-database.json'),
    maintenance = join(root, 'maintenance')
  const builtin = postgresConnection(),
    external = postgresConnection()
  FilePlatformDatabaseConfig.create(configFile, join(keys, 'master.key'), builtin)
  await copyFile(configFile, builtinFile)
  const saved = FilePlatformDatabaseConfig.open(configFile, data)
  FilePlatformDatabaseConfig.select(configFile, data, external, 'external')
  const retained = new PlatformDatabase(builtin, saved.security)
  await retained.claimDeployment(saved.deploymentId!, () => {})
  await retained.initialize()
  await retained.close()
  const pool = new Pool({ ...builtin, user: builtin.username }),
    observer = new Pool({ ...external, user: external.username })
  const guard = await pool.connect()
  const config = {
    listen: { host: '127.0.0.1', port: 0 },
    maintenanceFile: maintenance,
    platformDatabaseConfigFile: configFile,
    runtime: {
      command: process.execPath,
      args: ['tests/fixtures/runtime.mjs'],
      dataRoot: data,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  }
  let app = createCommunityApplication(config),
    child: ReturnType<typeof spawn> | undefined
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
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
    const revision = Number((await observer.query('SELECT revision FROM dsh_phalanx.shared_model_settings WHERE id=1')).rows[0].revision)
    await pool.query(`CREATE FUNCTION public.hold_rotation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(9001,42); RETURN NEW; END $$;
      CREATE TRIGGER hold_rotation BEFORE UPDATE ON dsh_phalanx.platform_security FOR EACH ROW EXECUTE FUNCTION public.hold_rotation()`)
    await guard.query('SELECT pg_advisory_lock(9001,42)')
    const recovery = join(keys, 'secret-recovery.json')
    if (kind === 'reset') {
      await writeFile(recovery, JSON.stringify({ activePassword: external.password, builtinPassword: builtin.password }), { mode: 0o600 })
      await rm(saved.security.masterKeyPath)
    }
    child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/composition/cli.ts',
        'master-key-' + kind,
        '--config-file',
        configFile,
        '--data-root',
        data + '/',
        '--maintenance-file',
        maintenance,
        '--offline',
        ...(kind === 'reset' ? ['--recovery-file', recovery, '--confirmation', 'RESET ALL PLATFORM SECRETS'] : []),
      ],
      { env: { PATH: process.env.PATH }, stdio: 'ignore' },
    )
    exited = new Promise(resolve => child!.once('close', (code, signal) => resolve({ code, signal })))
    await expect
      .poll(
        async () => {
          if (child!.exitCode !== null) throw Error('The rotation exited before the database barrier')
          return (
            await pool.query(
              "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=9001 AND objid=42 AND objsubid=2 AND NOT granted",
            )
          ).rowCount
        },
        { timeout: 10_000 },
      )
      .toBe(1)
    const fingerprint = (await observer.query("SELECT registry->>'masterFingerprint' AS fingerprint FROM dsh_phalanx.platform_security WHERE id=1")).rows[0]
      .fingerprint as string
    expect(fingerprint).not.toBe(saved.security.registry.masterFingerprint)
    const waiting = (
      await pool.query(
        "SELECT pid FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=9001 AND objid=42 AND objsubid=2 AND NOT granted",
      )
    ).rows
    expect(waiting).toHaveLength(1)
    child.kill('SIGKILL')
    expect((await exited).signal).toBe('SIGKILL')
    expect((await pool.query('SELECT pg_terminate_backend($1) AS terminated', [waiting[0].pid])).rows[0].terminated).toBe(true)
    await guard.query('SELECT pg_advisory_unlock(9001,42)')
    await pool.query('DROP TRIGGER hold_rotation ON dsh_phalanx.platform_security; DROP FUNCTION public.hold_rotation()')
    expect((await pool.query("SELECT registry->>'masterFingerprint' AS fingerprint FROM dsh_phalanx.platform_security WHERE id=1")).rows[0].fingerprint).toBe(
      saved.security.registry.masterFingerprint,
    )
    if (kind === 'reset') await rm(recovery) // Prepared recovery must no longer depend on plaintext input.
    const passwordFile = join(root, 'runtime-password')
    writeBuiltinDatabasePassword(builtinFile, data, passwordFile)
    expect(await readFile(passwordFile, 'utf8')).toBe(builtin.password)
    expect(FilePlatformDatabaseConfig.open(configFile, data).security.registry.masterFingerprint).toBe(fingerprint)
    if (kind === 'reset') {
      const recovered = await promisify(execFile)(process.execPath, [
        '--import',
        'tsx',
        'src/composition/cli.ts',
        'master-key-reset',
        '--config-file',
        configFile,
        '--data-root',
        data,
        '--maintenance-file',
        maintenance,
        '--offline',
        '--recovery-file',
        recovery,
        '--confirmation',
        'RESET ALL PLATFORM SECRETS',
      ])
      expect(JSON.parse(recovered.stdout)).toMatchObject({ status: 'recovered', fingerprint })
    }
    app = createCommunityApplication(config)
    const restarted = await app.start()
    const status = (await fetch(restarted + '/admin/api/session', { headers: { cookie } })).status
    if (kind === 'rotate') expect(status).toBe(200)
    else expect(status).not.toBe(200)
    expect((await pool.query("SELECT registry->>'masterFingerprint' AS fingerprint FROM dsh_phalanx.platform_security WHERE id=1")).rows[0].fingerprint).toBe(
      fingerprint,
    )
    if (kind === 'reset')
      expect(Number((await observer.query('SELECT revision FROM dsh_phalanx.shared_model_settings WHERE id=1')).rows[0].revision)).toBe(revision + 1)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    await app.stop()
    await guard.query('SELECT pg_advisory_unlock_all()')
    guard.release()
    await pool.query('DROP TRIGGER IF EXISTS hold_rotation ON dsh_phalanx.platform_security; DROP FUNCTION IF EXISTS public.hold_rotation()')
    await pool.end()
    await observer.end()
    await removeCommunityFixture(root)
  }
})
