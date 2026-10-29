import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { initializeBuiltinDatabase } from '../src/adapters/builtin-database-setup.js'
import { FilePlatformDatabaseConfig } from '../src/adapters/platform-database-config.js'
import { parseCommunityCommand } from '../src/inbound/community-command.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication, testDatabaseConfigFile } from './support/community-application.js'

const execute = promisify(execFile)
it('documents the read-only fingerprint command without loading a deployment', async () => {
  const result = await execute(process.execPath, ['--import', 'tsx', 'src/composition/cli.ts', '--help'], { env: { PATH: process.env.PATH } })
  expect(result.stdout).toContain('master-key-fingerprint --config-file PATH --data-root PATH')
  expect(result.stdout).toContain('offline backup')
  expect(result.stderr).toBe('')
})

it('queries the installed master-key fingerprint without opening a database or replacing the key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-operator-')),
    data = join(root, 'data')
  const config = join(root, 'database.json'),
    master = join(root, 'master.key')
  await mkdir(data)
  try {
    const installed = initializeBuiltinDatabase(config, master, data, 25432),
      original = await readFile(master)
    const result = await execute(
      process.execPath,
      ['--import', 'tsx', 'src/composition/cli.ts', 'master-key-fingerprint', '--config-file', config, '--data-root', data],
      { env: { PATH: process.env.PATH } },
    )
    expect(JSON.parse(result.stdout)).toEqual({ fingerprint: installed.fingerprint, masterKeyPath: master })
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain(original.toString('base64'))
    expect(await readFile(master)).toEqual(original)
  } finally {
    await removeCommunityFixture(root)
  }
})

it('rotates the protected master while preserving the administrator login after a fresh application start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-rotation-')),
    data = join(root, 'data'),
    maintenance = join(root, 'maintenance')
  await mkdir(data)
  const configFile = testDatabaseConfigFile(data),
    original = FilePlatformDatabaseConfig.open(configFile, data)
  FilePlatformDatabaseConfig.select(configFile, data, original.connection, 'builtin')
  const builtin = join(dirname(configFile), 'builtin-database.json')
  await copyFile(configFile, builtin)
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
  let app = createCommunityApplication(config)
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
    const before = await readFile(original.security.masterKeyPath)
    const rotate = () =>
      execute(
        process.execPath,
        [
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
        ],
        { env: { PATH: process.env.PATH } },
      )
    await expect(rotate()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('another platform process already owns this data root') })
    expect(await readFile(original.security.masterKeyPath)).toEqual(before)
    expect((await fetch(origin + '/admin/api/session', { headers: { cookie } })).status).toBe(200)
    await app.stop()
    await writeFile(maintenance, 'FOREIGN_MAINTENANCE', { mode: 0o600 })
    await expect(rotate()).rejects.toMatchObject({ code: 1 })
    expect(await readFile(maintenance, 'utf8')).toBe('FOREIGN_MAINTENANCE')
    expect(await readFile(original.security.masterKeyPath)).toEqual(before)
    await rm(maintenance)
    const result = await rotate()
    const rotated = JSON.parse(result.stdout) as { status: string; fingerprint: string }
    expect(rotated.status).toBe('rotated')
    expect(rotated.fingerprint).not.toBe(original.security.registry.masterFingerprint)
    expect(await readFile(original.security.masterKeyPath)).not.toEqual(before)
    expect(FilePlatformDatabaseConfig.open(configFile, data).security.registry.masterFingerprint).toBe(rotated.fingerprint)
    expect(FilePlatformDatabaseConfig.open(builtin, data).security.registry.masterFingerprint).toBe(rotated.fingerprint)
    app = createCommunityApplication(config)
    const restarted = await app.start()
    const session = await fetch(restarted + '/admin/api/session', { headers: { cookie } })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ username: 'admin', admin: true })
  } finally {
    await app.stop()
    await removeCommunityFixture(root)
  }
})

it('retains a managed operation and its admission marker until the root coordinator acknowledges completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-managed-key-')),
    data = join(root, 'data'),
    maintenance = join(root, 'maintenance')
  await mkdir(data)
  const configFile = testDatabaseConfigFile(data),
    saved = FilePlatformDatabaseConfig.open(configFile, data)
  await copyFile(configFile, join(dirname(configFile), 'builtin-database.json'))
  FilePlatformDatabaseConfig.select(configFile, data, { ...saved.connection, host: 'localhost' }, 'builtin')
  const app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    platformDatabaseConfigFile: configFile,
    runtime: {
      command: process.execPath,
      args: ['tests/fixtures/runtime.mjs'],
      dataRoot: data,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  try {
    await app.start()
    await app.stop()
    const operation = '11111111-1111-4111-8111-111111111111'
    const marker =
      JSON.stringify({
        schema: 1,
        ports: [
          { address: '127.0.0.1', port: 3080 },
          { address: '127.0.0.1', port: 3081 },
        ],
        operation,
        operationKind: 'master-key-rotate',
        deploymentId: saved.deploymentId,
      }) + '\n'
    await writeFile(maintenance, marker, { mode: 0o644 })
    const args = [
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
      '--managed-operation',
      operation,
    ]
    const first = JSON.parse((await execute(process.execPath, args)).stdout)
    expect(first).toMatchObject({ operation, deploymentId: saved.deploymentId, status: 'rotated' })
    expect(await readFile(maintenance, 'utf8')).toBe(marker)
    const journal = join(dirname(configFile), 'platform-key-operation.json')
    expect(JSON.parse(await readFile(journal, 'utf8'))).toMatchObject({ managedOperation: operation, phase: 'prepared' })
    const second = JSON.parse((await execute(process.execPath, args)).stdout)
    expect(second).toMatchObject({ operation, fingerprint: first.fingerprint, status: 'recovered' })
    expect(await readFile(maintenance, 'utf8')).toBe(marker)
  } finally {
    await app.stop()
    await removeCommunityFixture(root)
  }
})

it('routes installed operations to the independent root owner without accepting deployment paths', () => {
  expect(parseCommunityCommand(['master-key-rotate'])).toEqual({ kind: 'managed-operation', action: 'master-key-rotate' })
  expect(parseCommunityCommand(['maintenance-status'])).toEqual({ kind: 'managed-operation', action: 'maintenance-status' })
  expect(parseCommunityCommand(['maintenance-recover'])).toEqual({ kind: 'managed-operation', action: 'maintenance-recover' })
  expect(() => parseCommunityCommand(['maintenance-recover', '--command', 'arbitrary'])).toThrow()
})
