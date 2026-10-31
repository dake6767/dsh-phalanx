import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FilePlatformDatabaseConfig } from '../src/adapters/platform-database-config.js'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { platformDatabasePool } from '../src/adapters/platform-database-inspection.js'
import { PostgresDownloadSources } from '../src/adapters/postgres-download-sources.js'
import { readExecutorFacts } from '../src/adapters/platform-executor-facts.js'
import { postgresConnection } from './support/postgres.js'

it('reads only the source schema inventory without preparing it and observes each committed download choice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'executor-facts-')),
    data = join(root, 'data'),
    config = join(root, 'database.json'),
    connection = postgresConnection()
  mkdirSync(data, { mode: 0o700 })
  FilePlatformDatabaseConfig.create(config, join(root, 'master.key'), connection)
  const saved = FilePlatformDatabaseConfig.open(config, data),
    database = new PlatformDatabase(connection, saved.security),
    sql = platformDatabasePool(connection),
    store = new PostgresDownloadSources(database, { preset: 'mainland' })
  try {
    expect(await readExecutorFacts(config, data, 'schemas', ['dsh_phalanx', 'unprepared_source'])).toEqual({
      schemas: [
        { name: 'dsh_phalanx', version: 0 },
        { name: 'unprepared_source', version: 0 },
      ],
    })
    expect(await readExecutorFacts(config, data, 'check', ['dsh_phalanx', 'unprepared_source'])).toMatchObject({
      selection: null,
      schemas: [
        { name: 'dsh_phalanx', version: 0 },
        { name: 'unprepared_source', version: 0 },
      ],
    })
    expect((await sql.query("SELECT to_regnamespace('dsh_phalanx')::text AS namespace")).rows).toEqual([{ namespace: null }])
    await database.initialize()
    await store.initialize()
    expect(await readExecutorFacts(config, data, 'schemas', ['dsh_phalanx'])).toEqual({ schemas: [{ name: 'dsh_phalanx', version: 15 }] })
    expect(await readExecutorFacts(config, data, 'download-sources', ['dsh_phalanx'])).toEqual({ selection: null })
    await store.save({ preset: 'official' })
    expect(await readExecutorFacts(config, data, 'download-sources', ['dsh_phalanx'])).toEqual({ selection: { preset: 'official' } })
    await store.save({ preset: 'mainland', overrides: { pypi: 'https://packages.example.test/simple' } })
    expect(await readExecutorFacts(config, data, 'download-sources', ['dsh_phalanx'])).toEqual({
      selection: { preset: 'mainland', overrides: { pypi: 'https://packages.example.test/simple' } },
    })
    const role = connection.database + '_facts',
      originalConfiguration = readFileSync(config)
    await sql.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'facts-fixture'; GRANT CONNECT ON DATABASE "${connection.database}" TO "${role}";
      GRANT USAGE ON SCHEMA dsh_phalanx TO "${role}"; GRANT SELECT ON dsh_phalanx.download_sources TO "${role}"`)
    try {
      const staging = join(root, 'restricted.json')
      FilePlatformDatabaseConfig.stageSelection(
        config,
        data,
        { ...connection, username: role, password: 'facts-fixture' },
        'external',
        saved.security.registry,
        staging,
      )
      renameSync(staging, config)
      expect(await readExecutorFacts(config, data, 'check', ['dsh_phalanx'])).toMatchObject({
        selection: { preset: 'mainland', overrides: { pypi: 'https://packages.example.test/simple' } },
        schemas: null,
      })
    } finally {
      writeFileSync(config, originalConfiguration, { mode: 0o600 })
      await sql.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`)
    }
    // The selected connection can change between requests; never serve an old fact when it stops answering.
    const original = readFileSync(config),
      unavailable = createServer(socket => socket.destroy())
    unavailable.listen(0, '127.0.0.1')
    await once(unavailable, 'listening')
    try {
      const address = unavailable.address()
      if (!address || typeof address === 'string') throw Error('No controlled unavailable database endpoint')
      const staging = join(root, 'next-database.json')
      FilePlatformDatabaseConfig.stageSelection(
        config,
        data,
        { ...connection, host: '127.0.0.1', port: address.port },
        'external',
        saved.security.registry,
        staging,
      )
      renameSync(staging, config)
      await expect(readExecutorFacts(config, data, 'download-sources', ['dsh_phalanx'])).rejects.toThrow()
    } finally {
      writeFileSync(config, original, { mode: 0o600 })
      await new Promise<void>(resolve => unavailable.close(() => resolve()))
    }
    expect(await readExecutorFacts(config, data, 'download-sources', ['dsh_phalanx'])).toEqual({
      selection: { preset: 'mainland', overrides: { pypi: 'https://packages.example.test/simple' } },
    })
    expect((await sql.query("SELECT to_regnamespace('unprepared_source')::text AS namespace")).rows).toEqual([{ namespace: null }])
  } finally {
    await store.close()
    await database.close()
    await sql.end()
    rmSync(root, { recursive: true, force: true })
  }
})
