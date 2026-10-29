import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { PostgresExpertRows } from '../src/adapters/postgres-expert-rows.js'
import { YamlPluginAccessSyntax } from '../src/adapters/plugin-access-syntax.js'
import { ContributionTransactions } from '../src/use-cases/contribution-transactions.js'
import { expect, it } from 'vitest'
import { postgresSkillService } from './fixtures/postgres-skill-service.js'
import { createContributionStorage } from '../src/composition/contribution-storage.js'
import { PostgresExecutionConfigurations } from '../src/adapters/postgres-execution-configurations.js'
import type { MemberContribution } from '../src/domain/member-contribution.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'

it('commits the contribution, competing decisions and secret configuration together and never reapplies an adopted version', async () => {
  const upload = { name: 'guide', hash: 'a'.repeat(64), description: 'Guide', markdown: '# Guide', files: ['SKILL.md'] }
  const fixture = await postgresSkillService({ accept: async () => upload, read: async () => upload, collect: async () => {}, newToken: () => 'review' })
  const storage = createContributionStorage(fixture.database),
    execution = new PostgresExecutionConfigurations(fixture.database)
  try {
    await execution.initialize()
    const bob = await fixture.accounts.create({ username: 'bob', password: 'fixture-password', email: '' })
    const row: MemberContribution = {
      ...upload,
      id: 'first',
      revision: 'first-upload',
      contributor: fixture.member,
      declaration: {
        purpose: 'Share',
        execution: { commands: [{ command: 'guide', blocked: [] }], variables: [{ name: 'KEY', purpose: 'Authentication', application: 'Provider console' }] },
      },
      submittedAt: 1,
      updatedAt: 1,
      status: 'pending',
    }
    await storage.actions.submit(fixture.member, row)
    await storage.actions.submit(bob, { ...row, id: 'second', revision: 'second-upload', contributor: bob })
    const record = (await storage.rows.get(row.id))!
    async function* bytes() {
      yield new Uint8Array([1])
    }
    const preview = await fixture.library.upload(fixture.actor, bytes(), new AbortController().signal)
    const setup = {
      execution: { enabled: true, commands: [{ command: 'guide', blocked: [] }], variables: [{ name: 'KEY', value: 'fictional-adoption-key', secret: true }] },
    }
    const adopt = () =>
      fixture.library.confirm(fixture.actor, preview.token, preview.revision, {
        id: row.id,
        revision: row.revision,
        adoption: { row },
        committed: () => {},
        commit: skill => storage.actions.skill(fixture.actor, record, skill, setup, 2, preview.revision),
      })
    await fixture.database.query(`CREATE TABLE dsh_phalanx.reject_atomic_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_atomic_child(id integer REFERENCES dsh_phalanx.reject_atomic_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_atomic() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.reject_atomic_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_atomic AFTER INSERT ON dsh_phalanx.execution_configurations FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_atomic();`)
    await expect(adopt()).rejects.toMatchObject({ sqlState: '23503' })
    expect(await storage.rows.get('first')).toEqual(record)
    expect((await storage.rows.get('second'))?.row.status).toBe('pending')
    expect(await fixture.library.list(fixture.actor)).toEqual([])
    expect(await execution.get('skill:guide')).toBeUndefined()
    await fixture.database.query('DROP TRIGGER reject_atomic ON dsh_phalanx.execution_configurations')
    fixture.fault.projection = true
    await expect(adopt()).rejects.toMatchObject({ code: 'skill-sync-failed' })
    await fixture.library.recover()
    const committed = (await storage.rows.get('first'))!
    expect((await storage.rows.get('first'))?.row.status).toBe('adopted')
    expect((await storage.rows.get('second'))?.row).toMatchObject({ status: 'declined', reason: 'Another contribution with this name was adopted.' })
    const original = (await execution.get('skill:guide'))!
    await execution.save('skill:guide', { ...original, variables: [{ name: 'KEY', value: 'fictional-newer-administrator-key', secret: true }] })
    await fixture.library.setMaintainer(fixture.actor, row.name, bob.username, (await fixture.library.detail(fixture.actor, row.name)).maintenanceRevision!)
    await storage.actions.submit(bob, { ...row, id: 'third', revision: 'third-upload', contributor: bob })
    await fixture.accounts.delete(fixture.member.username)
    const before = await fixture.storage.library.list()
    const skill = before[0]!
    await storage.actions.skill(fixture.actor, record, skill, setup, 3, preview.revision)
    expect(await fixture.storage.library.list()).toEqual(before)
    expect((await execution.get('skill:guide'))?.variables[0]?.value).toBe('fictional-newer-administrator-key')
    expect((await storage.rows.get('third'))?.row.status).toBe('pending')
    expect((await storage.rows.get('first'))?.row.contributor.spaceId).toBe(fixture.member.spaceId)
    expect(await storage.rows.get('first')).toEqual(committed)
  } finally {
    await cleanupOwned(
      () => execution.close(),
      () => fixture.close(),
    )
  }
})

it('rechecks the current actor inside the write transaction', async () => {
  const fixture = await postgresSkillService(),
    storage = createContributionStorage(fixture.database)
  try {
    const row: MemberContribution = {
      id: 'pending',
      revision: 'upload',
      name: 'guide',
      hash: 'a'.repeat(64),
      description: '',
      markdown: '',
      files: [],
      contributor: fixture.member,
      declaration: { purpose: 'Share' },
      submittedAt: 0,
      updatedAt: 0,
      status: 'pending',
    }
    await storage.actions.submit(fixture.member, row)
    const record = (await storage.rows.get(row.id))!
    await fixture.accounts.resetPassword(fixture.member.username, 'new-member-password')
    await expect(storage.actions.withdraw(fixture.member, record, 1)).rejects.toMatchObject({ code: 'sign-in-required' })
    expect(await storage.rows.get(row.id)).toEqual(record)
    await expect(storage.actions.submit(fixture.member, { ...row, id: 'other', name: 'other' })).rejects.toMatchObject({ code: 'sign-in-required' })
    expect(await storage.rows.get('other')).toBeUndefined()
    await fixture.accounts.resetPassword(fixture.actor.username, 'new-administrator-password')
    await expect(storage.actions.decline(fixture.actor, record, 'Decline', 1)).rejects.toMatchObject({ code: 'sign-in-required' })
    expect(await storage.rows.get(row.id)).toEqual(record)
  } finally {
    await fixture.close()
  }
})

it('keeps the pending limit atomic across concurrent submissions for one author', async () => {
  const fixture = await postgresSkillService(),
    storage = createContributionStorage(fixture.database)
  try {
    const row: MemberContribution = {
      id: 'unused',
      revision: 'upload',
      name: 'unused',
      hash: 'a'.repeat(64),
      description: '',
      markdown: '',
      files: [],
      contributor: fixture.member,
      declaration: { purpose: 'Share' },
      submittedAt: 0,
      updatedAt: 0,
      status: 'pending',
    }
    for (let index = 0; index < 19; index++) await storage.actions.submit(fixture.member, { ...row, id: 'id-' + index, name: 'guide-' + index })
    const result = await Promise.allSettled([
      storage.actions.submit(fixture.member, { ...row, id: 'last-a', name: 'last-a' }),
      storage.actions.submit(fixture.member, { ...row, id: 'last-b', name: 'last-b' }),
    ])
    expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(result.find(row => row.status === 'rejected')).toMatchObject({ reason: { code: 'contribution-limit' } })
    expect((await storage.rows.list()).filter(record => record.row.status === 'pending')).toHaveLength(20)
  } finally {
    await fixture.close()
  }
})

it('lets unrelated prepared adoptions commit while another adoption is still open', async () => {
  let nextName = 'one'
  const fixture = await postgresSkillService({
      accept: async () => ({ name: nextName, hash: 'a'.repeat(64), description: '', markdown: '', files: [] }),
      read: async () => ({ markdown: '', files: [] }),
      collect: async () => {},
      newToken: () => nextName,
    }),
    storage = createContributionStorage(fixture.database)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    began = new Promise<void>(resolve => {
      entered = resolve
    })
  let first: Promise<void> | undefined, second: Promise<void> | undefined
  let firstError: unknown, secondError: unknown
  try {
    const base: MemberContribution = {
      id: 'one',
      revision: 'one-upload',
      name: 'one',
      hash: 'a'.repeat(64),
      description: '',
      markdown: '',
      files: [],
      contributor: fixture.member,
      declaration: { purpose: 'Share' },
      submittedAt: 0,
      updatedAt: 0,
      status: 'pending',
    }
    await storage.actions.submit(fixture.member, base)
    await storage.actions.submit(fixture.member, { ...base, id: 'two', revision: 'two-upload', name: 'two' })
    const a = (await storage.rows.get('one'))!,
      b = (await storage.rows.get('two'))!
    async function* bytes() {
      yield new Uint8Array([1])
    }
    const previewA = await fixture.library.upload(fixture.actor, bytes(), new AbortController().signal)
    nextName = 'two'
    const previewB = await fixture.library.upload(fixture.actor, bytes(), new AbortController().signal)
    const prepared = (record: typeof a) => ({
      name: record.row.name,
      description: '',
      hash: record.row.hash,
      importedAt: 1,
      published: false,
      contributionReceipt: { id: record.row.id, revision: record.row.revision },
    })
    const held = new ContributionTransactions(
      {
        run: (operation, committed) =>
          storage.work.run(async rows => {
            const result = await operation(rows)
            entered()
            await gate
            return result
          }, committed),
      },
      new YamlPluginAccessSyntax(),
    )
    first = held.skill(fixture.actor, a, prepared(a), undefined, 1, previewA.revision)
    void first.catch(error => {
      firstError = error
      entered()
    })
    await began
    if (firstError) throw firstError
    let completed = false
    second = storage.actions.skill(fixture.actor, b, prepared(b), undefined, 1, previewB.revision)
    void second.then(
      () => {
        completed = true
      },
      error => {
        secondError = error
      },
    )
    await expect
      .poll(
        () => {
          if (secondError) throw secondError
          return completed
        },
        { timeout: 5000 },
      )
      .toBe(true)
    expect((await storage.rows.get('two'))?.row.status).toBe('adopted')
    release()
    await Promise.all([first, second])
    expect((await storage.rows.get('one'))?.row.status).toBe('adopted')
  } finally {
    release?.()
    await Promise.allSettled([first, second])
    await fixture.close()
  }
})

it.each(['selection', 'pack-members', 'expert-removal'] as const)(
  'rejects a skill confirmation when %s changes after the owner checked its preview',
  async change => {
    const upload = { name: 'guide', description: 'Guide', hash: 'a'.repeat(64), markdown: '# Guide', files: ['SKILL.md'] },
      fixture = await postgresSkillService({ accept: async () => upload, read: async () => upload, collect: async () => {}, newToken: () => 'review' }),
      storage = createContributionStorage(fixture.database),
      experts = new PostgresExpertRows(fixture.database)
    let release!: () => void, entered!: () => void, adopting: Promise<unknown> | undefined
    const gate = new Promise<void>(resolve => {
        release = resolve
      }),
      began = new Promise<void>(resolve => {
        entered = resolve
      })
    try {
      await fixture.storage.library.save({ name: upload.name, description: 'Original', hash: 'b'.repeat(64), importedAt: 0, published: true })
      if (change === 'selection') await fixture.storage.selections.set(fixture.member.spaceId, [upload.name])
      if (change === 'pack-members')
        await fixture.storage.packs.store.save({ name: 'bundle', description: 'Bundle', instructions: '', skills: [upload.name], published: true })
      if (change === 'expert-removal')
        await experts.save({
          id: 'reader',
          name: 'Reader',
          description: 'Reads guides',
          icon: 'R',
          persona: 'Read.',
          examples: [],
          revision: 1,
          published: false,
          skills: [upload.name],
          skillPacks: [],
          plugins: [],
          mcp: [],
          model: null,
        })
      const row: MemberContribution = {
        ...upload,
        id: 'update',
        revision: 'upload-two',
        contributor: fixture.member,
        declaration: { purpose: 'Update' },
        submittedAt: 1,
        updatedAt: 1,
        status: 'pending',
      }
      await storage.actions.submit(fixture.member, row)
      const record = (await storage.rows.get(row.id))!
      async function* bytes() {
        yield new Uint8Array([1])
      }
      const preview = await fixture.library.upload(fixture.actor, bytes(), new AbortController().signal),
        before = await fixture.storage.library.list()
      adopting = fixture.library.confirm(fixture.actor, preview.token, preview.revision, {
        id: row.id,
        revision: row.revision,
        adoption: { row },
        committed: () => {},
        commit: async skill => {
          entered()
          await gate
          await storage.actions.skill(fixture.actor, record, skill, undefined, 2, preview.revision)
        },
      })
      const rejected = expect(adopting).rejects.toMatchObject({ code: 'skill-preview-changed' })
      try {
        await began
        if (change === 'selection') await fixture.storage.selections.set(fixture.member.spaceId, [])
        if (change === 'pack-members') await fixture.storage.packs.store.save({ ...(await fixture.storage.packs.store.list())[0]!, skills: [] })
        if (change === 'expert-removal') await experts.save({ ...(await experts.get('reader'))!, skills: [], revision: 2 })
        release()
        await rejected
      } finally {
        release()
        await Promise.allSettled([adopting, rejected])
      }
      expect(await fixture.storage.library.list()).toEqual(before)
      expect(await storage.rows.get(row.id)).toEqual(record)
      if (change === 'selection') expect(await fixture.storage.selections.get(fixture.member.spaceId)).toEqual([])
      if (change === 'pack-members') expect((await fixture.storage.packs.store.list())[0]?.skills).toEqual([])
      if (change === 'expert-removal') expect((await experts.get('reader'))?.skills).toEqual([])
    } finally {
      release?.()
      await Promise.allSettled(adopting ? [adopting] : [])
      await fixture.close()
    }
  },
)

it.each(['unrelated-pack-delete', 'selection-prune'] as const)('keeps the confirmed skill impact stable against %s until COMMIT', async change => {
  const upload = { name: 'guide', description: 'Guide', hash: 'a'.repeat(64), markdown: '# Guide', files: ['SKILL.md'] },
    fixture = await postgresSkillService({ accept: async () => upload, read: async () => upload, collect: async () => {}, newToken: () => 'review' }),
    storage = createContributionStorage(fixture.database)
  let release!: () => void, entered!: () => void, adopting: Promise<void> | undefined, modifying: Promise<void> | undefined
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    began = new Promise<void>(resolve => {
      entered = resolve
    })
  try {
    await fixture.storage.library.save({ name: upload.name, description: 'Original', hash: 'b'.repeat(64), importedAt: 0, published: true })
    await fixture.storage.packs.store.save({ name: 'unrelated', description: 'Unrelated', instructions: '', skills: [], published: true })
    await fixture.storage.packs.grants.set(fixture.member.groupId, ['unrelated'])
    await fixture.storage.selections.set(fixture.member.spaceId, [upload.name])
    const row: MemberContribution = {
      ...upload,
      id: 'update',
      revision: 'upload-two',
      contributor: fixture.member,
      declaration: { purpose: 'Update' },
      submittedAt: 1,
      updatedAt: 1,
      status: 'pending',
    }
    await storage.actions.submit(fixture.member, row)
    const record = (await storage.rows.get(row.id))!
    async function* bytes() {
      yield new Uint8Array([1])
    }
    const preview = await fixture.library.upload(fixture.actor, bytes(), new AbortController().signal)
    const held = new ContributionTransactions(
      {
        run: (operation, committed) =>
          storage.work.run(async rows => {
            const result = await operation(rows)
            entered()
            await gate
            return result
          }, committed),
      },
      new YamlPluginAccessSyntax(),
    )
    const previous = (await fixture.storage.library.list())[0]!
    adopting = held.skill(
      fixture.actor,
      record,
      { ...previous, hash: upload.hash, contributionReceipt: { id: row.id, revision: row.revision } },
      undefined,
      2,
      preview.revision,
    )
    await began
    let modified = false
    modifying = (
      change === 'unrelated-pack-delete' ? fixture.storage.packs.store.remove('unrelated') : fixture.storage.selections.retain([fixture.member.spaceId], [])
    ).then(() => {
      modified = true
    })
    await expect
      .poll(async () =>
        Number(
          (
            await fixture.database.query<{ waiting: string }>(
              "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
            )
          )[0]!.waiting,
        ),
      )
      .toBeGreaterThan(0)
    expect(modified).toBe(false)
    release()
    await adopting
    await modifying
    expect((await storage.rows.get(row.id))?.row.status).toBe('adopted')
    if (change === 'unrelated-pack-delete') expect(await fixture.storage.packs.grants.get(fixture.member.groupId)).toEqual([])
    else expect(await fixture.storage.selections.get(fixture.member.spaceId)).toEqual([])
  } finally {
    release?.()
    await Promise.allSettled([...(adopting ? [adopting] : []), ...(modifying ? [modifying] : [])])
    await fixture.close()
  }
})

it.each(['skill', 'plugin'] as const)('rechecks current %s maintainer ownership inside submission rather than trusting an earlier intake check', async kind => {
  const f = await postgresSkillService(),
    storage = createContributionStorage(f.database)
  try {
    const bob = await f.accounts.create({ username: 'bob', email: '', password: 'password' }),
      provenance = { anonymous: false, versions: [], maintainer: { username: bob.username, spaceId: bob.spaceId } }
    if (kind === 'skill')
      await f.storage.library.save({ name: 'guide', description: 'Guide', hash: 'b'.repeat(64), importedAt: 0, published: false, provenance })
    else
      await new PostgresPluginLibraryStore(f.database).save({
        packageName: 'guide',
        version: '1.0.0',
        current: null,
        stage: 'failed',
        published: false,
        provenance,
      })
    const row: MemberContribution = {
      id: 'submission',
      revision: 'upload',
      kind,
      name: 'guide',
      description: 'Guide',
      hash: 'a'.repeat(64),
      markdown: '',
      files: [],
      contributor: f.member,
      declaration: { purpose: 'Update' },
      submittedAt: 1,
      updatedAt: 1,
      status: 'pending',
    }
    await expect(storage.actions.submit(f.member, row)).rejects.toMatchObject({ code: 'contribution-maintainer-required' })
    expect(await storage.rows.list()).toEqual([])
  } finally {
    await f.close()
  }
})
