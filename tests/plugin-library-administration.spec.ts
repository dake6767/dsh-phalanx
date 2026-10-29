import { createHash } from 'node:crypto'
import { postgresSkillService } from './fixtures/postgres-skill-service.js'
import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import type { MemberContribution } from '../src/domain/member-contribution.js'
import { expect, it } from 'vitest'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'
import { PluginLibrary } from '../src/use-cases/plugin-library.js'

it('rejects an environment binding when its declared dependency is removed', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  let row: LibraryPlugin = { packageName: 'example', version: '1.0.0', stage: 'failed', current: null, published: false, runtimeDependencies: ['tool'] }
  const library = new PluginLibrary(
    { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    {
      list: async () => [row],
      save: async value => {
        row = value
      },
      remove: async () => {},
    },
    {
      prepare: async () => {
        throw Error('unused')
      },
    },
    undefined,
    undefined,
    undefined,
    {
      access: {
        remove: async () => {},
        get: async () => ({ revision: 'one', environment: [{ name: 'PATH', value: '{dependency:tool}' }], entriesYaml: '', entries: {} }),
      },
      upstreams: { save: async () => {} },
    },
    { readReady: async () => [] },
  )
  await expect(library.setRuntimeDependencies(actor, 'example', [])).rejects.toMatchObject({ kind: 'invalid' })
  expect(row.runtimeDependencies).toEqual(['tool'])
  await library.setRuntimeDependencies(actor, 'example', ['tool'])
  expect(row.runtimeDependencies).toEqual(['tool'])
})

it('retains the validated plugin row revision while contribution identity validation yields', async () => {
  const fixture = await postgresSkillService(),
    store = new PostgresPluginLibraryStore(fixture.database)
  let release!: () => void,
    entered!: () => void,
    paused = false
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    began = new Promise<void>(resolve => {
      entered = resolve
    })
  const library = new PluginLibrary(
    {
      get: async username => {
        const account = await fixture.accounts.get(username)
        if (username === fixture.member.username && !paused) {
          paused = true
          entered()
          await gate
        }
        return account
      },
    },
    store,
    {
      prepare: async () => {
        throw Error('No preparation during confirmed contribution')
      },
    },
    undefined,
    { impact: async () => ({ groups: 0, members: 0, selectedMembers: 0 }), revoke: async () => {} },
  )
  let adopting: Promise<void> | undefined
  try {
    const candidate = { packageName: 'example-plugin', version: '1.0.0' }
    const prepared = {
      ...candidate,
      integrity: 'sha512-' + createHash('sha512').update('original').digest('base64'),
      artifact: 'artifacts/original',
      runtimeRevision: 'runtime',
      title: 'Plugin',
      description: '',
      dependencies: {},
      bundlePatch: '[{"insert":[]}]',
    }
    await store.save({ ...candidate, current: prepared, stage: 'available', published: false })
    const impact = await library.impact(fixture.actor, candidate.packageName)
    const next = { ...prepared, version: '1.0.1', integrity: 'sha512-' + createHash('sha512').update('next').digest('base64'), artifact: 'artifacts/next' }
    const row: MemberContribution = {
      id: 'plugin-contribution',
      revision: 'contribution-revision',
      kind: 'plugin',
      name: candidate.packageName,
      hash: 'b'.repeat(64),
      description: '',
      markdown: '',
      files: [],
      contributor: fixture.member,
      declaration: { purpose: 'Share' },
      submittedAt: 0,
      updatedAt: 0,
      status: 'pending',
      plugin: { candidate: { ...candidate, version: next.version }, prepared: next },
    }
    adopting = library.adoptContribution(
      fixture.actor,
      row.plugin!.candidate,
      next,
      impact.revision,
      { id: row.id, revision: row.revision, adoption: { row } },
      () => {},
    )
    const verdict = expect(adopting).rejects.toMatchObject({ code: 'platform-configuration-conflict' })
    try {
      await began
      const current = (await store.list())[0]!
      await store.save({ ...current, provenance: { maintainer: null, anonymous: true, versions: [] } })
      release()
      await verdict
      expect((await store.list())[0]).toMatchObject({ current: { version: '1.0.0' }, provenance: { anonymous: true } })
    } finally {
      release()
      await Promise.allSettled([adopting, verdict])
    }
  } finally {
    release?.()
    await Promise.allSettled(adopting ? [adopting] : [])
    await library.stop()
    await fixture.close()
  }
})

it('delegates prepared adoption facts to the caller transaction and retains them only after COMMIT', async () => {
  const fixture = await postgresSkillService(),
    store = new PostgresPluginLibraryStore(fixture.database)
  const library = new PluginLibrary(fixture.accounts, store, {
    prepare: async () => {
      throw Error('unused')
    },
  })
  let rejectCommit = true,
    retained = false
  const candidate = { packageName: 'atomic-plugin', version: '1.0.0' },
    prepared = {
      ...candidate,
      integrity: 'sha512-' + createHash('sha512').update('atomic').digest('base64'),
      artifact: 'artifacts/atomic',
      runtimeRevision: 'runtime',
      title: 'Atomic',
      description: '',
      dependencies: {},
      bundlePatch: '[{"insert":[]}]',
    }
  const contribution = {
    id: 'atomic',
    revision: 'one',
    commit: async (row: LibraryPlugin, committed: () => void) => {
      await fixture.database.transaction(async sql => {
        await new PostgresPluginLibraryStore({ sql, cipher: fixture.database.cipher() }).save(row, 'none')
        if (rejectCommit) await sql.query('INSERT INTO dsh_phalanx.commit_children(parent) VALUES(1)')
      }, committed)
      throw Error('projection failed after commit')
    },
  }
  try {
    await fixture.database.query(`CREATE TABLE dsh_phalanx.commit_parents(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.commit_children(parent integer REFERENCES dsh_phalanx.commit_parents(id) DEFERRABLE INITIALLY DEFERRED)`)
    const adopt = () =>
      library.adoptContribution(fixture.actor, candidate, prepared, 'new', contribution, () => {
        retained = true
      })
    await expect(adopt()).rejects.toMatchObject({ code: 'query-failed', sqlState: '23503' })
    expect(retained).toBe(false)
    expect(await store.list()).toEqual([])
    rejectCommit = false
    await expect(adopt()).rejects.toThrow('projection failed after commit')
    expect(retained).toBe(true)
    expect((await store.list())[0]).toMatchObject({ packageName: candidate.packageName, contributionReceipt: { id: 'atomic', revision: 'one' } })
  } finally {
    await library.stop()
    await fixture.close()
  }
})
