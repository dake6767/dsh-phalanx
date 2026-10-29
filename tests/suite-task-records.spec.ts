import { expect, it } from 'vitest'
import { createSuiteStorage } from '../src/composition/suite-storage.js'
import { SuiteTaskRecords } from '../src/use-cases/suite-task-records.js'
import { postgresSuiteService, suiteVersion } from './fixtures/postgres-suite-service.js'

it('claims all install tasks and their request in one transaction and refuses a concurrent duplicate', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database),
    records = new SuiteTaskRecords(storage.work, { now: () => 2 })
  try {
    const entry = suiteVersion(1),
      input = { id: entry.id, requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'fictional-suite-key' } },
      pending = { id: entry.id, version: entry.version, category: entry.category, status: 'installing' as const, entries: [], updatedAt: 2, log: 'Installing.' }
    const outcomes = await Promise.allSettled([records.admit(f.actor, [pending], input), records.admit(f.actor, [pending], input)])
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(row => row.status === 'rejected')).toHaveLength(1)
    expect((await storage.installs.list()).map(row => row.record)).toEqual([pending])
    expect((await storage.requests.get(input.requestId))?.result).toEqual({ id: entry.id, version: entry.version, status: 'pending' })
    expect(JSON.stringify(await f.database.query('SELECT * FROM dsh_phalanx.catalog_installs'))).not.toContain('fictional-suite-key')
  } finally {
    await f.close()
  }
})

it('rejects a failed admission without leaving dependency tasks or a receipt and retries after the COMMIT fault is removed', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database),
    records = new SuiteTaskRecords(storage.work, { now: () => 2 })
  try {
    const input = { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' },
      pending = ['fixture-suite', 'fixture-dependency'].map(id => ({
        id,
        version: '1',
        status: 'installing' as const,
        entries: [],
        updatedAt: 2,
        log: 'Installing.',
      }))
    await f.database.query(`CREATE TABLE dsh_phalanx.reject_task_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_task_child(id integer REFERENCES dsh_phalanx.reject_task_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_task() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dsh_phalanx.reject_task_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_task AFTER INSERT ON dsh_phalanx.catalog_requests FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_task();`)
    await expect(records.admit(f.actor, pending, input)).rejects.toMatchObject({ sqlState: '23503' })
    expect(await storage.installs.list()).toEqual([])
    expect(await storage.requests.get(input.requestId)).toBeUndefined()
    await f.database.query('DROP TRIGGER reject_task ON dsh_phalanx.catalog_requests')
    await records.admit(f.actor, pending, input)
    expect(await storage.installs.list()).toHaveLength(2)
  } finally {
    await f.close()
  }
})

it('settles only the accepted task revision and never overwrites an expired request id reused by a later task', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database),
    records = new SuiteTaskRecords(storage.work, { now: () => 2 })
  try {
    const input = { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' },
      pending = { id: input.id, version: '1', status: 'installing' as const, entries: [], updatedAt: 2, log: 'Installing.' },
      admitted = await records.admit(f.actor, [pending], input)
    for (let index = 0; index < 200; index++) await storage.requests.save(`request-padding-${index}`, { id: 'other', version: '1', status: 'complete' })
    await storage.requests.save(input.requestId, { id: 'later-task', version: '2', status: 'pending' })
    const later = await storage.requests.get(input.requestId)
    await records.failInstall(admitted.installs, admitted.request, 'interrupted', 'Preparation failed.')
    expect((await storage.installs.get(input.id))?.record.status).toBe('failed')
    expect(await storage.requests.get(input.requestId)).toEqual(later)
    const completed = (await storage.installs.get(input.id))!
    await storage.installs.save({ ...completed.record, status: 'installed' }, completed.revision)
    const before = await storage.installs.get(input.id)
    await records.failInstall(admitted.installs, admitted.request, 'interrupted', 'Late failure.')
    expect(await storage.installs.get(input.id)).toEqual(before)
  } finally {
    await f.close()
  }
})
