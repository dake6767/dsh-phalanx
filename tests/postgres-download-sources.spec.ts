import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { FilePlatformSecrets } from '../src/adapters/platform-secrets.js'
import { PostgresDownloadSources } from '../src/adapters/postgres-download-sources.js'
import { postgresConnection } from './support/postgres.js'

async function withDatabase(test: (open: () => PlatformDatabase) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'download-sources-')),
    masterKeyPath = join(root, 'master.key')
  const created = FilePlatformSecrets.create(masterKeyPath),
    registry = created.registry()
  created.close()
  const connection = postgresConnection(),
    opened: PlatformDatabase[] = []
  try {
    await test(() => {
      const database = new PlatformDatabase(connection, { masterKeyPath, registry })
      opened.push(database)
      return database
    })
  } finally {
    for (const database of opened) await database.close()
    rmSync(root, { recursive: true, force: true })
  }
}

it('uses the installed choice until an administrator saves, then the database across restarts', async () => {
  await withDatabase(async open => {
    const database = open()
    await database.initialize()
    const installed = { preset: 'mainland' as const }
    const store = new PostgresDownloadSources(database, installed)
    await store.initialize()
    expect(store.get()).toEqual({ preset: 'mainland', saved: false })
    await store.save({ preset: 'official', overrides: { pypi: 'https://packages.example.test/simple' } })
    expect(store.get()).toEqual({ preset: 'official', overrides: { pypi: 'https://packages.example.test/simple' }, saved: true })
    await store.close()
    // A later start with a different installed choice keeps the administrator's saved value.
    const reopened = new PostgresDownloadSources(database, { preset: 'mainland' })
    await reopened.initialize()
    expect(reopened.get()).toMatchObject({ preset: 'official', saved: true })
    await reopened.close()
    expect(await database.query('SELECT revision FROM dsh_phalanx.download_sources')).toEqual([{ revision: '1' }])
  })
})

it('rejects an invalid selection without replacing the saved row', async () => {
  await withDatabase(async open => {
    const database = open()
    await database.initialize()
    const store = new PostgresDownloadSources(database, { preset: 'official' })
    await store.initialize()
    await store.save({ preset: 'mainland' })
    await expect(store.save({ preset: 'official', overrides: { npm: 'https://name:secret@example.test' } })).rejects.toThrow(
      expect.objectContaining({ code: 'download-source-invalid' }),
    )
    expect(store.get()).toMatchObject({ preset: 'mainland', saved: true })
    expect((await database.query<{ selection: unknown }>('SELECT selection FROM dsh_phalanx.download_sources'))[0]!.selection).toEqual({ preset: 'mainland' })
    await store.close()
  })
})

it('refuses a save when another process changed the row first', async () => {
  await withDatabase(async open => {
    const database = open(),
      other = open()
    await database.initialize()
    await other.initialize()
    const first = new PostgresDownloadSources(database, { preset: 'official' }),
      second = new PostgresDownloadSources(other, { preset: 'official' })
    await first.initialize()
    await second.initialize()
    await first.save({ preset: 'mainland' })
    await expect(second.save({ preset: 'official' })).rejects.toThrow(expect.objectContaining({ code: 'platform-configuration-conflict' }))
    await first.close()
    await second.close()
  })
})
