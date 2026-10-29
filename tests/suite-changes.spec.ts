import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { createSuiteStorage } from '../src/composition/suite-storage.js'
import { SuiteChanges } from '../src/use-cases/suite-changes.js'
import { SuiteTransactions } from '../src/use-cases/suite-transactions.js'
import { postgresSuiteService, suiteVersion } from './fixtures/postgres-suite-service.js'

async function fixture() {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database),
    signal = new AbortController(),
    changes = new SuiteChanges(new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 }), f.dependencies, f.library, 'amd64', () => signal.signal)
  const entry = suiteVersion(1),
    record = { id: entry.id, version: entry.version, category: entry.category, status: 'installing' as const, entries: [], updatedAt: 1, log: 'Installing.' }
  await storage.installs.save(record)
  await storage.requests.save('request-aaaaaaaaaaaa1', { id: entry.id, version: entry.version, status: 'pending' })
  const installed = (await storage.installs.get(entry.id))!,
    request = (await storage.requests.get('request-aaaaaaaaaaaa1'))!,
    options = { id: entry.id, requestId: request.requestId, credentials: { SUITE_KEY: 'fictional-suite-key' } }
  return { f, storage, changes, signal, entry, installed, request, options }
}

it('prepares and commits a catalog install and update while holding candidate artifacts and preserving execution credentials', async () => {
  const { f, storage, changes, entry, installed, request, options } = await fixture()
  let survived = false
  try {
    f.hooks.beforeGit = async () => {
      const prepared = [...f.preparedArtifacts]
      await f.dependencies.collectUnretained()
      survived = prepared.length > 0 && prepared.every(id => f.preparedArtifacts.has(id))
      expect(await f.storage.library.list()).toEqual([])
    }
    await changes.install(f.actor, [{ entry, installed }], options, request, async () => {})
    expect(survived).toBe(true)
    expect((await storage.requests.get(request.requestId))?.result.status).toBe('complete')
    expect(await f.runtime.execution.get('skill:one')).toMatchObject({ variables: [{ name: 'SUITE_KEY', value: 'fictional-suite-key', secret: true }] })
    const current = (await storage.installs.get(entry.id))!
    f.hooks.beforeGit = async () => {
      const prepared = [...f.preparedArtifacts]
      await f.dependencies.collectUnretained()
      expect(prepared).toHaveLength(2)
      expect(prepared.every(id => f.preparedArtifacts.has(id))).toBe(true)
      expect((await f.storage.library.list()).map(row => row.name)).toEqual(['obsolete', 'one'])
    }
    await changes.update(f.actor, current, suiteVersion(2), async () => {})
    expect((await storage.installs.get(entry.id))?.record.version).toBe('2')
    expect((await f.storage.library.list()).map(row => row.name)).toEqual(['one', 'two'])
    expect(await f.runtime.execution.get('skill:one')).toMatchObject({ variables: [{ name: 'SUITE_KEY', value: 'fictional-suite-key', secret: true }] })
    for (const row of await f.storage.library.list()) expect(await readFile(f.skillArtifactPath(row.hash), 'utf8')).toBe('prepared skill fixture')
    expect(() => f.library.preparedSuiteImport('suite:fixture-suite:change:1')).toThrow()
  } finally {
    await f.close()
  }
})

it('releases all prepared artifacts on a real COMMIT rejection, preserves the pending request and retries the same install', async () => {
  const { f, storage, changes, entry, installed, request, options } = await fixture()
  try {
    await f.database.query(`CREATE TABLE dsh_phalanx.reject_change_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_change_child(id integer REFERENCES dsh_phalanx.reject_change_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dsh_phalanx.reject_change_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_change AFTER INSERT ON dsh_phalanx.execution_configurations FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_change();`)
    await expect(changes.install(f.actor, [{ entry, installed }], options, request, async () => {})).rejects.toMatchObject({ sqlState: '23503' })
    expect(await storage.installs.get(entry.id)).toEqual(installed)
    expect(await storage.requests.get(request.requestId)).toEqual(request)
    expect(await f.storage.library.list()).toEqual([])
    expect(await f.storage.packs.store.list()).toEqual([])
    expect(await f.runtime.store.list()).toEqual([])
    expect(f.preparedArtifacts.size).toBe(0)
    expect(f.preparedSkillArtifacts.size).toBe(0)
    await f.database.query('DROP TRIGGER reject_change ON dsh_phalanx.execution_configurations')
    await changes.install(f.actor, [{ entry, installed }], options, request, async () => {})
    expect((await storage.installs.get(entry.id))?.record.status).toBe('installed')
  } finally {
    await f.close()
  }
})

it('cancels after Git staging without committing facts and releases every staging owner', async () => {
  const { f, storage, changes, signal, entry, installed, request, options } = await fixture()
  try {
    f.hooks.beforeGit = async () => signal.abort()
    await expect(changes.install(f.actor, [{ entry, installed }], options, request, async () => {})).rejects.toMatchObject({ name: 'AbortError' })
    expect(await storage.installs.get(entry.id)).toEqual(installed)
    expect(await storage.requests.get(request.requestId)).toEqual(request)
    expect(await f.storage.library.list()).toEqual([])
    expect(f.preparedArtifacts.size).toBe(0)
    expect(f.preparedSkillArtifacts.size).toBe(0)
  } finally {
    await f.close()
  }
})

it('freezes accepted wizard credentials across slow external preparation', async () => {
  const { f, storage, changes, entry, installed, request, options } = await fixture()
  try {
    f.hooks.beforeGit = async () => {
      options.credentials.SUITE_KEY = 'later-caller-mutation'
    }
    await changes.install(f.actor, [{ entry, installed }], options, request, async () => {})
    expect((await storage.installs.get(entry.id))?.record.status).toBe('installed')
    expect((await f.runtime.execution.get('skill:one'))?.variables).toEqual([{ name: 'SUITE_KEY', value: 'fictional-suite-key', secret: true }])
  } finally {
    await f.close()
  }
})
