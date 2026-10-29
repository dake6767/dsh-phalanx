import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { PlatformDatabase } from '../src/adapters/platform-database.js'
import { openTestDatabase } from './support/community-application.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { seedMcpParents } from './fixtures/mcp-parents.js'
import { createExpertStorage } from '../src/composition/expert-storage.js'
import { PostgresExpertRows } from '../src/adapters/postgres-expert-rows.js'
import { PostgresExpertReferences } from '../src/adapters/postgres-expert-references.js'
import { PostgresSkillLibraryStore } from '../src/adapters/postgres-skill-library.js'
import { PostgresSkillPackStore } from '../src/adapters/postgres-skill-packs.js'
import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { PostgresMcpStore } from '../src/adapters/postgres-mcp-store.js'
import type { Expert } from '../src/domain/expert.js'
import { mcpSecretContext } from '../src/domain/mcp-protected-values.js'

const definition: Expert = {
  id: 'writer',
  name: 'Writer',
  description: 'Reports',
  persona: 'Write.',
  icon: 'W',
  revision: 1,
  published: true,
  skills: ['reports'],
  skillPacks: ['report-pack'],
  plugins: ['report-plugin'],
  mcp: ['p-reports'],
  examples: [],
  model: null,
}
const targets = [
  { kind: 'skill', name: 'reports' },
  { kind: 'pack', name: 'report-pack' },
  { kind: 'plugin', name: 'report-plugin' },
  { kind: 'mcp', name: 'p-reports' },
] as const
async function bench() {
  const root = await mkdtemp(join(tmpdir(), 'expert-reference-transactions-'))
  let database: PlatformDatabase | undefined, other: PlatformDatabase | undefined, store: ReturnType<typeof createExpertStorage> | undefined
  const close = () =>
    cleanupOwned(
      async () => store?.close(),
      async () => database?.close(),
      async () => other?.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  try {
    database = await openTestDatabase(root)
    other = await openTestDatabase(root)
    store = createExpertStorage(database)
    await seedMcpParents(database, { groups: ['team'], spaces: ['member-space'] })
    await new PostgresSkillLibraryStore(database).save({ name: 'reports', description: 'Reports', hash: 'a'.repeat(64), importedAt: 0, published: false })
    await new PostgresSkillPackStore(database).save({ name: 'report-pack', description: 'Reports', instructions: '', skills: ['reports'], published: false })
    await new PostgresPluginLibraryStore(database).save({ packageName: 'report-plugin', version: '1.0.0', stage: 'resolving', current: null, published: false })
    const service = { name: 'p-reports', description: 'Reports', url: 'https://example.test', generation: 1 }
    await new PostgresMcpStore(database).save(service, mcpSecretContext([service]), 'none')
    await store.initialize()
    const state = await store.read()
    await store.update(state, { ...state, experts: [definition], grants: { team: ['writer'] }, selections: { 'member-space': ['writer'] } })
    return { database, other, store, close }
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Expert database fixture failed')
    }
    throw error
  }
}

it('rolls all four parent deletions, reference retirement and content versions back when PostgreSQL rejects COMMIT', async () => {
  const fixture = await bench(),
    { database, store } = fixture
  try {
    const original = await store.read(),
      version = store.view.version()
    const remove = () =>
      database.transaction(async sql => {
        await new PostgresExpertReferences({ sql, cipher: database.cipher() }).detach(targets)
        await sql.query("DELETE FROM dsh_phalanx.skill_packs WHERE name='report-pack'")
        await sql.query("DELETE FROM dsh_phalanx.skills WHERE name='reports'")
        await sql.query("DELETE FROM dsh_phalanx.plugin_library WHERE package_name='report-plugin'")
        await sql.query("DELETE FROM dsh_phalanx.mcp_services WHERE name='p-reports'")
      })
    await database.query(`CREATE TABLE dsh_phalanx.commit_parents(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.commit_children(id integer REFERENCES dsh_phalanx.commit_parents(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_expert_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO dsh_phalanx.commit_children VALUES(42); RETURN NULL; END $$;
      CREATE TRIGGER reject_expert_commit AFTER UPDATE ON dsh_phalanx.experts FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_expert_commit();`)
    await expect(remove()).rejects.toMatchObject({ code: 'query-failed', sqlState: '23503' })
    expect(await store.read()).toEqual(original)
    expect(store.view.version()).toBe(version)
    expect((await store.references.impact(targets)).experts).toEqual([{ id: 'writer', name: 'Writer' }])
    await database.query('DROP TRIGGER reject_expert_commit ON dsh_phalanx.experts')
    await remove()
    expect((await store.read()).experts).toMatchObject([{ id: 'writer', revision: 2, skills: [], skillPacks: [], plugins: [], mcp: [] }])
    expect(store.view.version()).not.toBe(version)
  } finally {
    await fixture.close()
  }
})

it('rejects a deletion preview after a new expert reference arrives without changing either definition', async () => {
  const fixture = await bench(),
    { database, store } = fixture
  try {
    const impact = await store.references.impact(targets)
    await new PostgresExpertRows(database).save({ ...definition, id: 'second', name: 'Second' }, 'none')
    const current = await store.read()
    await expect(store.references.detach(targets, impact.revision)).rejects.toMatchObject({ code: 'expert-stale' })
    expect(await store.read()).toEqual(current)
  } finally {
    await fixture.close()
  }
})

it('lets a parent deletion finish before a waiting editor and refuses revival of the deleted reference', async () => {
  const fixture = await bench(),
    { database, other, store } = fixture
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let locked!: () => void
  const ready = new Promise<void>(resolve => {
    locked = resolve
  })
  let deleting: Promise<void> | undefined, editing: Promise<unknown> | undefined
  try {
    const original = (await store.read()).experts[0]!
    deleting = database.transaction(async sql => {
      await sql.query("SELECT name FROM dsh_phalanx.skills WHERE name='reports' FOR UPDATE")
      locked()
      await gate
      await new PostgresExpertReferences({ sql, cipher: database.cipher() }).detach([{ kind: 'skill', name: 'reports' }])
      await sql.query("DELETE FROM dsh_phalanx.skills WHERE name='reports'")
    })
    await Promise.race([
      ready,
      deleting.then(() => {
        throw Error('Deletion completed before its lock barrier')
      }),
    ])
    let pid = 0
    editing = other
      .transaction(async sql => {
        pid = (await sql.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid
        await new PostgresExpertRows({ sql, cipher: other.cipher() }).save({ ...original, description: 'Edited' }, original.rowRevision!)
      })
      .then(
        () => ({ code: 'unexpected-success' }),
        error => error,
      )
    await expect
      .poll(
        async () =>
          (await database.query<{ waiting: boolean }>("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid]))[0]?.waiting,
      )
      .toBe(true)
    release()
    await deleting
    expect(await editing).toMatchObject({ code: 'expert-stale' })
    expect((await store.read()).experts[0]).toMatchObject({ skills: [], revision: 2, description: 'Reports' })
  } finally {
    release()
    await Promise.allSettled([deleting, editing])
    await fixture.close()
  }
})

it('cascades removed policy owners and invalidates the synchronous authorization fence', async () => {
  const fixture = await bench(),
    { database, store } = fixture
  try {
    const initial = store.view.version()
    await database.query("DELETE FROM dsh_phalanx.groups WHERE id='team'")
    expect((await store.read()).grants).toEqual({})
    expect(store.view.version()).not.toBe(initial)
    const afterGroup = store.view.version()
    await database.query("DELETE FROM dsh_phalanx.accounts WHERE space_id='member-space'")
    expect((await store.read()).selections).toEqual({})
    expect(store.view.version()).not.toBe(afterGroup)
    expect((await store.read()).experts).toHaveLength(1)
  } finally {
    await fixture.close()
  }
})
