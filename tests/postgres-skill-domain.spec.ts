import { PostgresSkillFacts } from '../src/adapters/postgres-skill-facts.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { PostgresSkillLibraryStore } from '../src/adapters/postgres-skill-library.js'
import { PostgresSkillPackStore } from '../src/adapters/postgres-skill-packs.js'
import { PostgresSkillAssignments } from '../src/adapters/postgres-skill-assignments.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { PostgresUnitOfWork } from '../src/adapters/postgres-unit-of-work.js'
import { openTestDatabase } from './support/community-application.js'

const skill = (name: string) => ({ name, description: name, hash: 'a'.repeat(64), importedAt: 1, published: true })

it('rolls back a batch import and a referenced skill deletion, then cascades only retired skill relations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-domain-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database),
      library = new PostgresSkillLibraryStore(database),
      packs = new PostgresSkillPackStore(database)
    const member = await accounts.create({ username: 'member', email: '', password: 'password' })
    const grants = new PostgresSkillAssignments(database, 'skills', 'grants'),
      choices = new PostgresSkillAssignments(database, 'skills', 'selections')
    await library.save(skill('one'))
    await packs.save({ name: 'workflow', description: 'Workflow', instructions: 'Run', published: true, skills: ['one'] })
    await grants.grantContribution!('default', 'one', { id: 'receipt', revision: 'approved' })
    await choices.set(member.spaceId, ['one'])
    const before = {
      skills: await library.list(),
      packs: await packs.list(),
      grants: await grants.get('default'),
      choices: await choices.get(member.spaceId),
      receipt: await grants.contributionReceipt!('default', 'one'),
    }
    const work = new PostgresUnitOfWork(database, { library: tx => new PostgresSkillLibraryStore(tx), packs: tx => new PostgresSkillPackStore(tx) })
    await expect(
      work.run(async tx => {
        await tx.library.save(skill('two'))
        await tx.packs.save({ ...(await tx.packs.list())[0]!, skills: ['one', 'two'] })
        throw Error('import failed')
      }),
    ).rejects.toThrow('import failed')
    expect(await library.list()).toEqual(before.skills)
    expect(await packs.list()).toEqual(before.packs)
    await expect(
      work.run(async tx => {
        await tx.library.remove('one')
        throw Error('delete failed')
      }),
    ).rejects.toThrow('delete failed')
    expect({
      skills: await library.list(),
      packs: await packs.list(),
      grants: await grants.get('default'),
      choices: await choices.get(member.spaceId),
      receipt: await grants.contributionReceipt!('default', 'one'),
    }).toEqual(before)
    await work.run(async tx => {
      await tx.library.remove('one')
    })
    expect(await grants.get('default')).toEqual([])
    expect(await grants.contributionReceipt!('default', 'one')).toBeUndefined()
    expect(await choices.get(member.spaceId)).toEqual([])
    expect((await packs.list())[0]?.skills).toEqual([])
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('renames pack membership, grants, choices and receipts together and preserves their order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-rename-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database),
      library = new PostgresSkillLibraryStore(database),
      packs = new PostgresSkillPackStore(database)
    const member = await accounts.create({ username: 'member', email: '', password: 'password' })
    const grants = new PostgresSkillAssignments(database, 'packs', 'grants'),
      choices = new PostgresSkillAssignments(database, 'packs', 'selections')
    await library.save(skill('one'))
    await library.save(skill('two'))
    await packs.save({ name: 'old', description: 'Workflow', instructions: 'Run', published: true, skills: ['one', 'two'] })
    await grants.grantContribution!('default', 'old', { id: 'receipt', revision: 'approved' })
    await choices.set(member.spaceId, ['old'])
    const original = (await packs.list())[0]!
    const work = new PostgresUnitOfWork(database, { packs: tx => new PostgresSkillPackStore(tx) })
    await expect(
      work.run(async tx => {
        await tx.packs.rename('old', { ...original, name: 'next', skills: ['two', 'one'] })
        throw Error('rename failed')
      }),
    ).rejects.toThrow('rename failed')
    expect(await packs.list()).toEqual([original])
    expect(await grants.get('default')).toEqual(['old'])
    expect(await choices.get(member.spaceId)).toEqual(['old'])
    await work.run(async tx => {
      await tx.packs.rename('old', { ...original, name: 'next', skills: ['two', 'one'] })
    })
    expect((await packs.list())[0]).toMatchObject({ name: 'next', skills: ['two', 'one'] })
    expect(await grants.get('default')).toEqual(['next'])
    expect(await choices.get(member.spaceId)).toEqual(['next'])
    expect(await grants.contributionReceipt!('default', 'next')).toEqual({ id: 'receipt', revision: 'approved' })
    expect(await grants.contributionReceipt!('default', 'old')).toBeUndefined()
    await expect(packs.save({ ...original, name: 'next', skills: [] })).rejects.toMatchObject({ code: 'skill-preview-changed' })
    const current = (await packs.list())[0]!
    await expect(packs.save({ ...current, skills: ['missing'] })).rejects.toThrow()
    expect(await packs.list()).toEqual([current])
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('cascades account and group lifetimes while grant receipts survive ordinary revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-parents-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database),
      library = new PostgresSkillLibraryStore(database),
      packs = new PostgresSkillPackStore(database)
    const group = await accounts.createGroup('Team'),
      member = await accounts.create({ username: 'member', email: '', password: 'password' })
    await library.save(skill('one'))
    await packs.save({ name: 'workflow', description: 'Workflow', instructions: '', published: true, skills: ['one'] })
    for (const kind of ['skills', 'packs'] as const) {
      const grants = new PostgresSkillAssignments(database, kind, 'grants'),
        choices = new PostgresSkillAssignments(database, kind, 'selections'),
        name = kind === 'skills' ? 'one' : 'workflow'
      await grants.grantContribution!(group.id, name, { id: 'receipt', revision: 'approved' })
      await choices.set(member.spaceId, [name])
      await grants.set(group.id, [])
      expect(await grants.contributionReceipt!(group.id, name)).toEqual({ id: 'receipt', revision: 'approved' })
      await grants.set(group.id, [name])
    }
    await accounts.deleteGroup(group.id)
    await accounts.delete('member')
    for (const kind of ['skills', 'packs'] as const) {
      const grants = new PostgresSkillAssignments(database, kind, 'grants'),
        choices = new PostgresSkillAssignments(database, kind, 'selections')
      expect(await grants.get(group.id)).toEqual([])
      expect(await choices.get(member.spaceId)).toEqual([])
      expect(await grants.contributionReceipt!(group.id, kind === 'skills' ? 'one' : 'workflow')).toBeUndefined()
    }
    expect(await library.list()).toHaveLength(1)
    expect(await packs.list()).toHaveLength(1)
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('refuses a stale skill row rather than overwriting a newer save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-revision-'))
  const database = await openTestDatabase(root)
  try {
    const library = new PostgresSkillLibraryStore(database)
    await library.save(skill('one'))
    const stale = (await library.list())[0]!
    await library.save({ ...stale, published: false })
    await expect(library.save({ ...stale, published: true })).rejects.toMatchObject({ code: 'skill-preview-changed' })
    expect((await library.list())[0]?.published).toBe(false)
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('publishes skill and pack choices after parent cascades and never publishes a rolled-back unit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-view-parents-'))
  const database = await openTestDatabase(root)
  const facts = new PostgresSkillFacts(database)
  try {
    const accounts = new PostgresCommunityAccountStore(database),
      library = new PostgresSkillLibraryStore(database),
      packs = new PostgresSkillPackStore(database)
    const group = await accounts.createGroup('Team'),
      member = await accounts.create({ username: 'member', email: '', password: 'password' })
    await library.save(skill('one'))
    await packs.save({ name: 'workflow', description: 'Workflow', instructions: '', published: true, skills: ['one'] })
    await facts.initialize()
    for (const kind of ['skills', 'packs'] as const) {
      await new PostgresSkillAssignments(database, kind, 'grants').set(group.id, [kind === 'skills' ? 'one' : 'workflow'])
      await new PostgresSkillAssignments(database, kind, 'selections').set(member.spaceId, [kind === 'skills' ? 'one' : 'workflow'])
    }
    expect(facts.grants.get(group.id)).toEqual(['one'])
    expect(facts.packs.selections.get(member.spaceId)).toEqual(['workflow'])
    const original = facts.library.list()
    await expect(
      new PostgresUnitOfWork(database, { library: tx => new PostgresSkillLibraryStore(tx) }).run(async tx => {
        await tx.library.save(skill('two'))
        expect(facts.library.list()).toEqual(original)
        throw Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(facts.library.list()).toEqual(original)
    await accounts.deleteGroup(group.id)
    expect(facts.grants.get(group.id)).toEqual([])
    expect(facts.packs.grants.get(group.id)).toEqual([])
    await accounts.delete('member')
    expect(facts.selections.get(member.spaceId)).toEqual([])
    expect(facts.packs.selections.get(member.spaceId)).toEqual([])
  } finally {
    await facts.close()
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
