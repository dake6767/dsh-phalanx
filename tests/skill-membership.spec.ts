import { asyncSkillFacts, asyncSkillPackFacts } from './fixtures/async-skill-facts.js'
import { expect, it } from 'vitest'
import { SkillMembership } from '../src/use-cases/skill-membership.js'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'

it('grants from the group, checks fresh impact and reconciles changes and retirement without instance actions', async () => {
  let accounts = [
    { username: 'admin', spaceId: 'admin-space', groupId: 'admins', admin: true, disabled: false, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 },
    { username: 'member', spaceId: 'member-space', groupId: 'ordinary', admin: false, disabled: false, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 },
  ]
  let rows: LibrarySkill[] = [{ name: 'example', description: 'Example', hash: 'v1', importedAt: 0, published: false }]
  const groups = [
    { id: 'admins', name: 'Admins', kind: 'admin' as const, isDefault: false, memberCount: 1 },
    { id: 'ordinary', name: 'Members', kind: 'ordinary' as const, isDefault: true, memberCount: 1 },
  ]
  const reader = {
    get: async (username: string) => accounts.find(account => account.username === username),
    list: async () => accounts,
    listGroups: async () => groups,
  }
  const assignments = () => {
    let values: Record<string, readonly string[]> = {}
    return {
      get: (id: string) => values[id] ?? [],
      set: (id: string, names: readonly string[]) => {
        values[id] = names
      },
      retain: (ids: readonly string[], names: readonly string[]) => {
        values = Object.fromEntries(
          Object.entries(values)
            .filter(([id]) => ids.includes(id))
            .map(([id, selected]) => [id, selected.filter(name => names.includes(name))]),
        )
      },
    }
  }
  const grants = assignments(),
    selections = assignments(),
    library = { list: () => rows }
  let failDistribution = false
  let projection: readonly { spaceId: string; skills: readonly LibrarySkill[] }[] = []
  const membership = new SkillMembership(
    reader,
    asyncSkillFacts(library),
    asyncSkillFacts(grants),
    asyncSkillFacts(selections),
    new MemberEffectiveSkills(reader, library, grants, selections),
    {
      synchronize: async value => {
        if (failDistribution) {
          projection = value.slice(0, 1)
          throw new Error('Disk full')
        }
        projection = value
      },
    },
  )
  expect(await membership.impact('example')).toEqual({ managedMembers: 0, selectedMembers: 0 })
  expect(await membership.grantCount('admins')).toBe(0)
  expect(await membership.market('admin', [])).toEqual([])
  const before = await membership.group('ordinary')
  await membership.save('ordinary', ['example'], before.revision)
  expect(projection.map(member => [member.spaceId, member.skills.map(skill => skill.name)])).toEqual([
    ['admin-space', []],
    ['member-space', ['example']],
  ])
  expect(await membership.grantCount('ordinary')).toBe(1)
  await expect(membership.save('ordinary', [], before.revision)).rejects.toMatchObject({ code: 'skill-preview-changed' })
  await membership.save('admins', ['example'], (await membership.group('admins')).revision)
  expect(await membership.grantCount('admins')).toBe(1)
  expect((await membership.group('admins')).skills[0]?.granted).toBe(true)
  await membership.save('admins', [], (await membership.group('admins')).revision)
  await expect(membership.save('ordinary', ['missing'], (await membership.group('ordinary')).revision)).rejects.toMatchObject({ code: 'skill-unavailable' })
  failDistribution = true
  await expect(membership.save('ordinary', [], (await membership.group('ordinary')).revision)).rejects.toMatchObject({ code: 'skill-sync-failed' })
  expect(grants.get('ordinary')).toEqual([])
  expect(membership.synchronization()).toEqual({ pending: true })
  failDistribution = false
  await membership.reconcile()
  expect(membership.synchronization()).toEqual({ pending: false })
  expect(projection.find(member => member.spaceId === 'member-space')?.skills).toEqual([])
  await membership.save('ordinary', ['example'], (await membership.group('ordinary')).revision)
  rows = []
  await membership.reconcile()
  // Reconciliation projects facts; PostgreSQL owns retirement cascades.
  expect(projection.find(member => member.spaceId === 'member-space')?.skills).toEqual([])
  expect(grants.get('ordinary')).toEqual(['example'])
  accounts = accounts.filter(account => account.username === 'admin')
  await membership.reconcile()
  expect(projection.map(member => member.spaceId)).toEqual(['admin-space'])
})

it('grants packs as a unit and updates effective distribution when their contents change', async () => {
  const account = {
    username: 'member',
    spaceId: 'space',
    groupId: 'group',
    admin: false,
    disabled: false,
    sessionEpoch: 0,
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }
  const accounts = {
    get: async () => account,
    list: async () => [account],
    listGroups: async () => [{ id: 'group', name: 'Group', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }],
  }
  const assignments = () => {
    let names: readonly string[] = []
    return {
      get: () => names,
      set: (_id: string, values: readonly string[]) => {
        names = values
      },
      retain: () => {},
    }
  }
  const grants = assignments(),
    selections = assignments(),
    packGrants = assignments(),
    packSelections = assignments()
  let children = ['one']
  const packs = {
    store: { list: () => [{ name: 'bundle', description: 'Bundle', skills: children, instructions: '', published: true }], save: () => {}, remove: () => {} },
    grants: packGrants,
    selections: packSelections,
  }
  const library = { list: () => ['one', 'two'].map(name => ({ name, description: name, hash: name, importedAt: 0, published: name === 'two' })) }
  let projected: readonly string[] = []
  const effective = new MemberEffectiveSkills(accounts, library, grants, selections, packs)
  const service = new SkillMembership(
    accounts,
    asyncSkillFacts(library),
    asyncSkillFacts(grants),
    asyncSkillFacts(selections),
    effective,
    {
      synchronize: async members => {
        projected = members[0]!.skills.map(skill => skill.name)
      },
    },
    undefined,
    asyncSkillPackFacts(packs),
  )
  await service.save('group', [], (await service.group('group')).revision, ['bundle'])
  expect(projected).toEqual(['one'])
  children = ['one', 'two']
  await service.reconcile()
  expect(projected).toEqual(['one', 'two'])
  await service.save('group', [], (await service.group('group')).revision, [])
  packSelections.set('space', ['bundle'])
  await service.reconcile()
  expect(await service.market('member', [])).toEqual([expect.objectContaining({ name: 'two', selectable: true, selectedDirectly: false })])
  await service.save('group', ['one'], (await service.group('group')).revision, [])
  expect(await service.market('member', [])).toEqual([
    expect.objectContaining({ name: 'one', source: 'managed', selectable: false }),
    expect.objectContaining({ name: 'two', selectable: true }),
  ])
  await service.save('group', [], (await service.group('group')).revision, [])
  await service.select('member', 'two', true)
  packSelections.set('space', [])
  await service.reconcile()
  expect(projected).toEqual(['two'])
})

it('skips unchanged launch distribution after dependency recovery and invalidates inputs or output state', async () => {
  const account = {
    username: 'member',
    spaceId: 'space',
    groupId: 'group',
    admin: false,
    disabled: false,
    sessionEpoch: 0,
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }
  const accounts = {
    get: async () => account,
    list: async () => [account],
    listGroups: async () => [{ id: 'group', name: 'Group', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }],
  }
  let names: readonly string[] = [],
    output = 'one',
    recovered = 0,
    published = 0,
    failed = false
  const assignments = {
    get: () => names,
    set: (_id: string, value: readonly string[]) => {
      names = value
    },
    retain: () => {},
  }
  const library = { list: (): LibrarySkill[] => [{ name: 'writing', description: 'Writes', hash: 'one', importedAt: 0, published: true }] }
  const service = new SkillMembership(
    accounts,
    asyncSkillFacts(library),
    asyncSkillFacts(assignments),
    asyncSkillFacts(assignments),
    new MemberEffectiveSkills(accounts, library, assignments, assignments),
    {
      snapshot: async () => ({ inputs: 'dependencies', outputs: output }),
      synchronize: async () => {
        published++
        if (failed) throw Error('failed')
      },
    },
    async () => {
      recovered++
    },
  )
  await service.reconcile(true)
  await service.reconcile(true)
  expect(published).toBe(1)
  expect(recovered).toBe(2)
  names = ['writing']
  await service.reconcile(true)
  expect(published).toBe(2)
  output = 'changed'
  await service.reconcile(true)
  expect(published).toBe(3)
  failed = true
  await expect(service.reconcile()).rejects.toMatchObject({ code: 'skill-sync-failed' })
  failed = false
  await service.reconcile(true)
  expect(published).toBe(5)
  Object.assign(account, { spaceId: 'replacement' })
  await service.reconcile(true)
  expect(published).toBe(6)
})

it('does not prune assignments or publish an empty projection when an account read fails', async () => {
  const account = {
    username: 'member',
    spaceId: 'space',
    groupId: 'members',
    sessionEpoch: 0,
    admin: false,
    disabled: false,
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }
  let retained = 0,
    published = 0
  const accounts = {
    get: async () => {
      throw Error('Account lookup unavailable')
    },
    list: async () => [account],
    listGroups: async () => [{ id: 'members', name: 'Members', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }],
  }
  const library = { list: () => [{ name: 'writing', description: '', hash: 'fixture', importedAt: 0, published: false }] }
  const assignments = {
    get: () => ['writing'],
    set() {},
    retain: () => {
      retained++
    },
  }
  const membership = new SkillMembership(
    accounts,
    asyncSkillFacts(library),
    asyncSkillFacts(assignments),
    asyncSkillFacts(assignments),
    new MemberEffectiveSkills(accounts, library, assignments),
    {
      synchronize: async () => {
        published++
      },
    },
  )
  await expect(membership.reconcile()).rejects.toMatchObject({ code: 'skill-sync-failed' })
  expect(retained).toBe(0)
  expect(published).toBe(0)
})

it('waits for an accepted asynchronous grant write before publishing or confirming its member projection', async () => {
  const account = {
    username: 'member',
    spaceId: 'space',
    groupId: 'group',
    admin: false,
    disabled: false,
    sessionEpoch: 0,
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }
  const accounts = {
    get: async () => account,
    list: async () => [account],
    listGroups: async () => [{ id: 'group', name: 'Group', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }],
  }
  const library = { list: (): LibrarySkill[] => [{ name: 'writing', description: 'Writes', hash: 'one', importedAt: 0, published: true }] }
  let names: readonly string[] = [],
    published = 0,
    completed = false
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => {
    enter = resolve
  })
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const grants = {
    get: () => names,
    set: async (_id: string, next: readonly string[]) => {
      enter()
      await gate
      names = next
    },
    retain: () => {},
  }
  const selections = { get: () => [], set: () => {}, retain: () => {} }
  let projection: readonly string[] = []
  const service = new SkillMembership(
    accounts,
    asyncSkillFacts(library),
    asyncSkillFacts(grants),
    asyncSkillFacts(selections),
    new MemberEffectiveSkills(accounts, library, grants, selections),
    {
      synchronize: async members => {
        published++
        projection = members.flatMap(member => member.skills.map(skill => skill.name))
      },
    },
  )
  const saving = service.save('group', ['writing'], (await service.group('group')).revision).then(() => {
    completed = true
  })
  try {
    await entered
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(published).toBe(0)
    expect(completed).toBe(false)
  } finally {
    release()
    await saving
  }
  expect(projection).toEqual(['writing'])
  expect(completed).toBe(true)
})
