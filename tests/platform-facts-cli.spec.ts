import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { FilePlatformDatabaseConfig } from '../src/adapters/platform-database-config.js'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { PostgresDownloadSources } from '../src/adapters/postgres-download-sources.js'
import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { postgresConnection } from './support/postgres.js'

const execute = promisify(execFile)
const facts = (args: readonly string[]) =>
  execute(process.execPath, ['--import', 'tsx', 'src/composition/cli.ts', 'platform-facts', ...args], { env: { PATH: process.env.PATH } }).then(
    result => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
    (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  )

async function withDeployment(test: (paths: { config: string; data: string; root: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'platform-facts-')),
    data = join(root, 'data'),
    config = join(root, 'database.json')
  await mkdir(data)
  try {
    FilePlatformDatabaseConfig.create(config, join(root, 'master.key'), postgresConnection())
    await test({ config, data, root })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('reports no saved download choice until an administrator saves, then the saved row, without writing', async () => {
  await withDeployment(async ({ config, data }) => {
    // Before any platform start the schema does not exist yet; the fact reader must not create it.
    expect(await facts(['download-sources', '--config-file', config, '--data-root', data])).toEqual({ code: 0, stdout: '{"selection":null}\n', stderr: '' })
    const saved = FilePlatformDatabaseConfig.open(config, data),
      database = new PlatformDatabase(saved.connection, saved.security)
    try {
      await database.initialize()
      expect(await database.query("SELECT to_regclass('dsh_phalanx.download_sources') IS NOT NULL AS present")).toEqual([{ present: true }])
      expect(JSON.parse((await facts(['download-sources', '--config-file', config, '--data-root', data])).stdout)).toEqual({ selection: null })
      const store = new PostgresDownloadSources(database, { preset: 'official' })
      await store.initialize()
      await store.save({ preset: 'mainland', overrides: { pypi: 'https://packages.example.test/simple' } })
      await store.close()
      const result = await facts(['download-sources', '--config-file', config, '--data-root', data])
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ selection: { preset: 'mainland', overrides: { pypi: 'https://packages.example.test/simple' } } })
    } finally {
      await database.close()
    }
  })
})

it('exits 2 with a readable diagnostic and no connection secrets when the database cannot answer', async () => {
  await withDeployment(async ({ config, data }) => {
    const saved = FilePlatformDatabaseConfig.open(config, data)
    const unreachable = join(data, '..', 'unreachable.json')
    FilePlatformDatabaseConfig.create(unreachable, join(data, '..', 'unreachable.key'), { ...saved.connection, port: 1 })
    const result = await facts(['download-sources', '--config-file', unreachable, '--data-root', data])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Platform database is unavailable')
    expect(result.stderr).not.toContain(saved.connection.password)
  })
})

it('prints the plugin rows the startup budget counts, and an empty list when no library exists', async () => {
  await withDeployment(async ({ config, data }) => {
    expect(JSON.parse((await facts(['plugin-budget-rows', '--config-file', config, '--data-root', data])).stdout)).toEqual({ schema: 1, plugins: [] })
    const saved = FilePlatformDatabaseConfig.open(config, data),
      database = new PlatformDatabase(saved.connection, saved.security)
    try {
      await database.initialize()
      const library = new PostgresPluginLibraryStore(database)
      await library.save({
        packageName: 'a',
        version: '1.0.0',
        stage: 'failed',
        current: null,
        published: false,
        checkedFor: 'x',
        replacement: { version: '2.0.0', packageName: 'a', stage: 'failed', prepared: null },
      })
      await library.save({ packageName: 'b', version: '1.0.0', stage: 'failed', current: null, published: false, checkedFor: '0.1.26/rev' })
    } finally {
      await database.close()
    }
    const result = await facts(['plugin-budget-rows', '--config-file', config, '--data-root', data])
    expect(JSON.parse(result.stdout)).toEqual({
      schema: 1,
      plugins: [
        { removing: false, checkedFor: 'x', replacement: true },
        { removing: false, checkedFor: '0.1.26/rev', replacement: false },
      ],
    })
    expect(result.stdout).not.toContain('not-exported')
    expect((await facts(['plugin-budget-rows', '--data-root', data])).code).toBe(1)
  })
})

it('reports a malformed saved row as an error, not as an unavailable database, and an unselected database as nothing saved', async () => {
  await withDeployment(async ({ config, data, root }) => {
    const saved = FilePlatformDatabaseConfig.open(config, data),
      database = new PlatformDatabase(saved.connection, saved.security)
    try {
      await database.initialize()
      await database.query(`INSERT INTO dsh_phalanx.download_sources(id,selection,revision) VALUES(1,'{"preset":"nowhere"}',1)`)
      const malformed = await facts(['download-sources', '--config-file', config, '--data-root', data])
      expect(malformed.code).toBe(1)
      expect(malformed.stderr).toContain('saved download sources in the platform database are invalid')
    } finally {
      await database.close()
    }
    expect(await facts(['download-sources', '--config-file', join(root, 'not-selected.json'), '--data-root', data])).toEqual({
      code: 0,
      stdout: '{"selection":null}\n',
      stderr: '',
    })
  })
})
