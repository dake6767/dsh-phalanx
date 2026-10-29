import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openTestDatabase } from './support/community-application.js'
import { PostgresCatalogInstalls, PostgresCatalogRequests } from '../src/adapters/postgres-catalog-records.js'
import { PostgresSkillLibraryStore } from '../src/adapters/postgres-skill-library.js'
import { PostgresUnitOfWork } from '../src/adapters/postgres-unit-of-work.js'
import type { CatalogInstallRecord } from '../src/domain/catalog-install.js'

const installed: CatalogInstallRecord = {
  id: 'writing',
  version: '1.0.0',
  status: 'installed',
  entries: [{ kind: 'skill', name: 'guide' }],
  requestId: 'request-writing',
  updatedAt: 1,
  log: 'Installed.',
}

it('commits catalog rows, request results and library facts together and preserves the receipt after its install is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-rows-atomic-')),
    database = await openTestDatabase(root),
    installs = new PostgresCatalogInstalls(database),
    requests = new PostgresCatalogRequests(database),
    library = new PostgresSkillLibraryStore(database)
  const work = new PostgresUnitOfWork(database, {
    installs: tx => new PostgresCatalogInstalls(tx),
    requests: tx => new PostgresCatalogRequests(tx),
    library: tx => new PostgresSkillLibraryStore(tx),
  })
  const commit = () =>
    work.run(async rows => {
      await rows.requests.save('request-writing', { id: 'writing', version: '1.0.0', status: 'complete' })
      await rows.library.save({ name: 'guide', description: 'Guide', hash: 'a'.repeat(64), importedAt: 1, published: false }, 'none')
      await rows.installs.save(installed)
    })
  try {
    await database.query(`CREATE TABLE dsh_phalanx.reject_catalog_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_catalog_child(id integer REFERENCES dsh_phalanx.reject_catalog_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_catalog() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dsh_phalanx.reject_catalog_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_catalog AFTER INSERT ON dsh_phalanx.catalog_installs FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_catalog();`)
    await expect(commit()).rejects.toMatchObject({ sqlState: '23503' })
    expect(await installs.list()).toEqual([])
    expect(await requests.get('request-writing')).toBeUndefined()
    expect(await library.list()).toEqual([])
    await database.query('DROP TRIGGER reject_catalog ON dsh_phalanx.catalog_installs')
    await commit()
    const record = (await installs.get('writing'))!
    expect(record.record).toEqual(installed)
    expect((await requests.get('request-writing'))?.result).toEqual({ id: 'writing', version: '1.0.0', status: 'complete' })
    expect((await library.list())[0]?.name).toBe('guide')
    await installs.remove(record.record.id, record.revision)
    expect(await requests.get('request-writing')).toBeDefined()
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('updates only the selected catalog row and rejects both stale row writes and persistent compensation snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-rows-cas-')),
    database = await openTestDatabase(root),
    installs = new PostgresCatalogInstalls(database)
  try {
    await installs.save(installed)
    await installs.save({ ...installed, id: 'other', requestId: 'other-request' })
    const first = (await installs.get('writing'))!,
      second = (await installs.get('other'))!
    await Promise.all([
      installs.save({ ...first.record, log: 'First changed.' }, first.revision),
      installs.save({ ...second.record, log: 'Second changed.' }, second.revision),
    ])
    await expect(installs.save({ ...first.record, log: 'Stale.' }, first.revision)).rejects.toMatchObject({ code: 'suite-task-running' })
    expect((await installs.get('writing'))?.record.log).toBe('First changed.')
    expect((await installs.get('other'))?.record.log).toBe('Second changed.')
    await expect(installs.save(Object.assign({ ...installed, id: 'snapshot' }, { updating: { skills: [] } }))).rejects.toMatchObject({
      code: 'suite-catalog-invalid',
    })
    expect(await installs.get('snapshot')).toBeUndefined()
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('deduplicates concurrent request claims and retains the newest 200 receipts across reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-requests-retention-')),
    database = await openTestDatabase(root),
    requests = new PostgresCatalogRequests(database)
  try {
    const result = { id: 'writing', version: '1.0.0', status: 'pending' as const }
    const claimed = await Promise.allSettled([requests.save('request-0', result), requests.save('request-0', result)])
    expect(claimed.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(claimed.filter(value => value.status === 'rejected')).toMatchObject([{ reason: { code: 'suite-request-retired' } }])
    const initial = (await requests.get('request-0'))!
    await requests.save('request-0', { ...result, status: 'complete' }, initial.revision)
    await expect(requests.save('request-0', { ...result, status: 'failed' }, initial.revision)).rejects.toMatchObject({ code: 'suite-request-retired' })
    for (let id = 1; id < 200; id++) await requests.save('request-' + id, result)
    await Promise.all([requests.save('request-200', result), requests.save('request-201', result)])
    const reopened = new PostgresCatalogRequests(database)
    expect(await reopened.get('request-0')).toBeUndefined()
    expect(await reopened.get('request-1')).toBeUndefined()
    expect((await reopened.get('request-2'))?.result).toEqual(result)
    expect((await reopened.get('request-201'))?.result).toEqual(result)
    expect((await database.query('SELECT request_id FROM dsh_phalanx.catalog_requests')).length).toBe(200)
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
