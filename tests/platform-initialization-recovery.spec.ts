import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { initializationRecoveryProgram } from '../scripts/install/database-program.mjs'
import { expect, it } from 'vitest'
import { FilePlatformDatabaseConfig as Config } from '../src/adapters/platform-database-config.js'
import { readExecutorFacts } from '../src/adapters/platform-executor-facts.js'
import { prepareInitializationRecovery } from '../src/adapters/platform-initialization-recovery.js'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { platformDatabasePool } from '../src/adapters/platform-database-inspection.js'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { postgresConnection } from './support/postgres.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'

async function fixture(selected: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'initialization-recovery-')),
    dataRoot = join(root, 'data'),
    configFile = join(root, 'database.json'),
    connection = postgresConnection()
  mkdirSync(dataRoot, { mode: 0o700 })
  Config.create(configFile, join(root, 'master.key'), connection)
  copyFileSync(configFile, join(root, 'builtin-database.json'))
  if (selected) Config.select(configFile, dataRoot, connection, 'builtin')
  const proof = await readExecutorFacts(configFile, dataRoot, 'rotation', [])
  if (!('initializationPending' in proof)) throw Error('Missing rotation proof')
  return { root, connection, request: { configFile, dataRoot, proof, storage: { container: false } } }
}

it('prepares empty-schema storage through source owners while normal maintenance startup stays read-only', async () => {
  const { root, request } = await fixture(true),
    marker = join(root, 'maintenance')
  writeFileSync(marker, 'closed')
  const files = [request.configFile, join(root, 'builtin-database.json'), join(root, 'master.key')],
    before = files.map(path => readFileSync(path)),
    config = {
      listen: { host: '127.0.0.1', port: 0 },
      platformDatabaseConfigFile: request.configFile,
      maintenanceFile: marker,
      runtime: {
        command: '/unavailable-dsh',
        args: [],
        dataRoot: request.dataRoot,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
      },
    }
  let app = createCommunityApplication(config)
  try {
    await expect(app.start()).rejects.toMatchObject({ code: 'runtime-storage-unavailable' })
    expect(await prepareInitializationRecovery(request)).toEqual({ prepared: true })
    // Idempotent after a complete preparation, without replacing keys, configuration or invitation.
    expect(await prepareInitializationRecovery(request)).toEqual({ prepared: true })
    app = createCommunityApplication(config)
    const origin = await app.start()
    expect((await fetch(origin + '/healthz')).status).toBe(200)
    expect((await fetch(origin + '/readyz')).status).toBe(200)
    expect((await fetch(origin + '/bootstrap')).status).toBe(503)
    expect(readBootstrapCredential(request.dataRoot)).toBeDefined()
    expect(files.map(path => readFileSync(path))).toEqual(before)
    expect(readFileSync(marker, 'utf8')).toBe('closed')
  } finally {
    await app.stop()
    await removeCommunityFixture(root)
  }
})

it('resumes a preparation interrupted after schema commit but before storage identity creation', async () => {
  const { root, request, connection } = await fixture(true),
    saved = Config.open(request.configFile, request.dataRoot),
    database = new PlatformDatabase(connection, saved.security)
  try {
    await database.initialize()
    await database.close()
    const source = join(root, 'predecessor')
    for (const [layer, names] of [
      [
        'adapters',
        [
          'platform-database-config',
          'platform-secrets',
          'platform-database-inspection',
          'platform-schema',
          'platform-database',
          'platform-lock',
          'postgres-user-storage-facts',
          'user-storage-guard',
          'platform-store-lifecycle',
        ],
      ],
      ['domain', ['business-error', 'download-source']],
    ] as const) {
      mkdirSync(join(source, 'dist', layer), { recursive: true })
      for (const name of names)
        writeFileSync(join(source, 'dist', layer, name + '.js'), `export * from ${JSON.stringify(pathToFileURL(resolve('src', layer, name + '.ts')).href)};`)
    }
    // The predecessor has its original owners, but no initialization-recovery adapter.
    const program = await initializationRecoveryProgram()
    const output = await new Promise<string>((accept, reject) => {
      const child = execFile(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', program, 'recovery', source],
        { encoding: 'utf8' },
        (error, stdout) => (error ? reject(Error('Generated initialization recovery failed')) : accept(stdout)),
      )
      child.stdin!.end(JSON.stringify(request))
    })
    expect(JSON.parse(output)).toEqual({ prepared: true })
    expect(output).not.toContain(connection.password)
  } finally {
    await database.close()
    await removeCommunityFixture(root)
  }
})

it('leaves an unselected database uninitialized', async () => {
  const { root, request, connection } = await fixture(false),
    sql = platformDatabasePool(connection)
  try {
    expect(await prepareInitializationRecovery(request)).toEqual({ prepared: false })
    expect((await sql.query("SELECT to_regnamespace('dsh_phalanx')::text AS namespace")).rows).toEqual([{ namespace: null }])
  } finally {
    await sql.end()
    await removeCommunityFixture(root)
  }
})

it('retains the source storage owners refusal of nonempty or foreign external storage', async () => {
  for (const carrier of ['member-data', '.dsh-phalanx-storage.json']) {
    const { root, request } = await fixture(true),
      external = join(root, 'external')
    mkdirSync(external, { mode: 0o700 })
    writeFileSync(join(external, carrier), 'foreign retained data')
    try {
      await expect(prepareInitializationRecovery({ ...request, storage: { container: false, userDataRoot: external } })).rejects.toMatchObject({
        code: 'runtime-storage-unavailable',
      })
      expect(readFileSync(join(external, carrier), 'utf8')).toBe('foreign retained data')
    } finally {
      await removeCommunityFixture(root)
    }
  }
})
