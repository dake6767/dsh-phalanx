import { asyncExpertFacts } from './fixtures/async-expert-facts.js'
import { asyncSkillFacts } from './fixtures/async-skill-facts.js'
import { expect, it } from 'vitest'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import { Experts } from '../src/use-cases/experts.js'
import type { ExpertState } from '../src/domain/expert.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'
import type { CommunityUserInstance } from '../src/ports/community-runtime.js'
import { YamlPluginAccessSyntax } from '../src/adapters/plugin-access-syntax.js'

it('admits expert skills and pack notes without global distribution, retaining independent grants after withdrawal', async () => {
  let state: ExpertState = { revision: 0, experts: [], grants: {}, selections: {} }
  let direct: string[] = []
  const accounts = ['admin', 'member'].map(username => ({
    username,
    spaceId: username,
    sessionEpoch: 0,
    email: '',
    admin: username === 'admin',
    groupId: username === 'admin' ? 'admins' : 'members',
    disabled: false,
    createdAt: 0,
    updatedAt: 0,
  }))
  const accountStore = {
    get: async (name: string) => accounts.find(row => row.username === name),
    list: async () => accounts,
    listGroups: async () => [
      { id: 'admins', name: 'Admins', kind: 'admin' as const, memberCount: 1, isDefault: false },
      { id: 'members', name: 'Members', kind: 'ordinary' as const, memberCount: 1, isDefault: true },
    ],
  }
  const skill = (name: string): LibrarySkill => ({ name, description: name, hash: name, importedAt: 0, published: false })
  const library = { list: () => [skill('research'), skill('writing')] }
  const packs = {
    list: async () => [
      { name: 'marketing', description: 'Marketing', skills: ['writing'], instructions: 'Use writing', published: false, note: skill('marketing') },
    ],
  }
  const plugin = {
    packageName: 'expert-tool',
    version: '1.0.0',
    integrity: 'hash',
    artifact: 'artifact',
    runtimeRevision: 'runtime',
    title: 'Tool',
    description: '',
    dependencies: {},
    bundlePatch: JSON.stringify([{ id: 'tools', insert: [{ id: 'main', name: './main.js' }] }]),
  }
  const core = {
    ...plugin,
    packageName: 'core-tool',
    bundlePatch: JSON.stringify([{ id: 'web', config: {} }, { insert: [{ id: 'main', name: './main.js' }] }]),
  }
  const experts = new Experts(
    accountStore,
    asyncExpertFacts({
      read: () => structuredClone(state),
      write: next => {
        state = structuredClone(next)
      },
    }),
    asyncSkillFacts(library),
    asyncSkillFacts(packs),
    () => 'commerce',
    undefined,
    undefined,
    undefined,
    {
      list: async () => [plugin, core].map(current => ({ ...current, current, stage: 'available' as const, published: false })),
      eligible: plugin => new YamlPluginAccessSyntax().expertEligible(plugin),
    },
    async () => [{ name: 'p-research', description: 'Research MCP' }],
  )
  const effective = new MemberEffectiveSkills(accountStore, library, { get: () => direct }, undefined, undefined, experts)
  const actor = { username: 'admin', spaceId: 'admin', sessionEpoch: 0 }
  const input = {
    name: 'Commerce',
    description: 'Marketing',
    icon: 'C',
    persona: 'Use marketing methods.',
    skills: ['research'],
    skillPacks: ['marketing'],
    plugins: ['expert-tool'],
    mcp: ['p-research'],
  }
  await expect(experts.save(actor, { ...input, plugins: ['core-tool'] }, await experts.revision())).rejects.toMatchObject({
    code: 'expert-plugin-core-modification',
  })
  await expect(experts.save(actor, { ...input, mcp: ['p-missing'] }, await experts.revision())).rejects.toMatchObject({ code: 'expert-invalid' })
  await experts.save(actor, input, await experts.revision())
  expect((await experts.list(actor)).plugins).toEqual([
    { packageName: 'expert-tool', title: 'Tool', eligible: true },
    { packageName: 'core-tool', title: 'Tool', eligible: false },
  ])
  expect((await experts.list(actor)).mcp).toEqual([{ name: 'p-research', description: 'Research MCP' }])
  expect(await experts.owned('member')).toEqual([])
  expect(await experts.owned('admin')).toEqual([])
  await expect(
    experts.grant({ username: 'member', spaceId: 'member', sessionEpoch: 0 }, 'members', ['commerce'], await experts.revision()),
  ).rejects.toMatchObject({
    code: 'admin-required',
  })
  await expect(experts.grant(actor, 'members', ['commerce'], '0')).rejects.toMatchObject({ code: 'expert-stale' })
  await experts.grant(actor, 'admins', ['commerce'], await experts.revision())
  expect((await experts.owned('admin')).map(row => row.id)).toEqual(['commerce'])
  expect((await experts.group(actor, 'admins')).experts[0]?.granted).toBe(true)
  await experts.grant(actor, 'admins', [], await experts.revision())
  expect(await experts.owned('admin')).toEqual([])
  await experts.grant(actor, 'members', ['commerce'], await experts.revision())
  expect(await experts.plugins('member')).toEqual([plugin])
  expect(await experts.mcp('member')).toEqual(['p-research'])
  expect(await effective.effective('member')).toEqual([])
  expect((await effective.accessible('member')).map(row => row.name)).toEqual(['marketing', 'research', 'writing'])
  direct = ['research']
  expect((await effective.effective('member')).map(row => row.skill.name)).toEqual(['research'])
  await experts.grant(actor, 'members', [], await experts.revision())
  expect(await experts.plugins('member')).toEqual([])
  expect(await experts.mcp('member')).toEqual([])
  expect((await effective.accessible('member')).map(row => row.name)).toEqual(['research'])
  accounts[1]!.disabled = true
  expect(await effective.accessible('member')).toEqual([])
})

it('unions published summons by member space with grants, clears unpublished summons and retains independent capability sources', async () => {
  let state: ExpertState = { revision: 0, experts: [], grants: {}, selections: {} },
    sequence = 0
  let direct: string[] = []
  const accounts = ['admin', 'alice', 'bob'].map(username => ({
    username,
    spaceId: username + '-space',
    sessionEpoch: 0,
    email: '',
    admin: username === 'admin',
    groupId: username === 'admin' ? 'admins' : 'members',
    disabled: false,
    createdAt: 0,
    updatedAt: 0,
  }))
  const accountStore = {
    get: async (name: string) => accounts.find(row => row.username === name),
    list: async () => accounts,
    listGroups: async () => [
      { id: 'admins', name: 'Admins', kind: 'admin' as const, memberCount: 1, isDefault: false },
      { id: 'members', name: 'Members', kind: 'ordinary' as const, memberCount: 2, isDefault: true },
    ],
  }
  const library = { list: (): readonly LibrarySkill[] => [{ name: 'research', description: 'Research', hash: 'research', importedAt: 0, published: false }] }
  const plugin = {
    packageName: 'expert-tool',
    version: '1.0.0',
    integrity: 'hash',
    artifact: '/private/artifact',
    runtimeRevision: 'runtime',
    title: 'Tool',
    description: '',
    dependencies: {},
    bundlePatch: '[]',
  }
  const experts = new Experts(
    accountStore,
    asyncExpertFacts({
      read: () => structuredClone(state),
      write: next => {
        state = structuredClone(next)
      },
    }),
    asyncSkillFacts(library),
    asyncSkillFacts({ list: () => [] }),
    () => 'expert-' + ++sequence,
    undefined,
    undefined,
    undefined,
    { list: async () => [{ ...plugin, current: plugin, stage: 'available' as const, published: false }], eligible: () => true },
    async () => [{ name: 'p-research', description: 'Research MCP' }],
  )
  const actor = (username: string) => ({ username, spaceId: username + '-space', sessionEpoch: 0 })
  const admin = actor('admin'),
    alice = actor('alice'),
    bob = actor('bob')
  const input = {
    name: 'Commerce',
    description: 'Marketing',
    icon: 'C',
    persona: 'Private persona',
    skills: ['research'],
    skillPacks: [],
    plugins: ['expert-tool'],
    mcp: ['p-research'],
    examples: ['Plan a launch', 'Review a campaign'],
  }
  const first = await experts.save(admin, input, await experts.revision())
  expect(first.examples).toEqual(input.examples)
  await expect(experts.save(admin, { ...input, examples: ['Only one'] }, await experts.revision())).rejects.toMatchObject({ code: 'expert-invalid' })
  await expect(experts.market({ ...alice, sessionEpoch: 1 })).rejects.toThrow('Sign in is required')
  await expect(experts.select({ ...alice, spaceId: 'another-space' }, first.id, true)).rejects.toMatchObject({ code: 'sign-in-required' })
  expect((await experts.market(alice)).experts).toEqual([])
  await expect(experts.select(alice, first.id, true)).rejects.toMatchObject({ code: 'expert-unavailable' })
  await expect(experts.publish(alice, first.id, true, await experts.revision())).rejects.toMatchObject({ code: 'admin-required' })
  await expect(experts.publish(admin, first.id, true, '0')).rejects.toMatchObject({ code: 'expert-stale' })
  await experts.publish(admin, first.id, true, await experts.revision())
  expect(await experts.owned('alice')).toEqual([])
  expect((await experts.market(alice)).experts[0]).toMatchObject({ id: first.id, status: 'available', examples: input.examples, plugins: ['expert-tool'] })
  expect(JSON.stringify(await experts.market(alice))).not.toContain('Private persona')
  expect(JSON.stringify(await experts.market(alice))).not.toContain('/private/artifact')
  expect(await experts.select(alice, first.id, true)).toMatchObject({ application: 'restart-required' })
  expect((await experts.market(alice)).experts[0]?.status).toBe('summoned')
  expect(await experts.mcp('alice')).toEqual(['p-research'])
  expect((await experts.market(bob)).experts[0]?.status).toBe('available')
  accounts[1]!.spaceId = 'replacement-space'
  expect(await experts.owned('alice')).toEqual([])
  accounts[1]!.spaceId = alice.spaceId
  await experts.recover()
  expect((await experts.owned('alice')).map(row => row.id)).toEqual([first.id])
  const effective = new MemberEffectiveSkills(accountStore, library, { get: () => direct }, undefined, undefined, experts)
  expect(await effective.effective('alice')).toEqual([])
  expect((await effective.accessible('alice')).map(row => row.name)).toEqual(['research'])
  const second = await experts.save(admin, { ...input, name: 'Writer' }, await experts.revision())
  await experts.publish(admin, second.id, true, await experts.revision())
  await experts.select(alice, second.id, true)
  await experts.select(alice, first.id, false)
  expect((await experts.owned('alice')).map(row => row.id)).toEqual([second.id])
  expect(await experts.plugins('alice')).toEqual([plugin])
  expect(await experts.mcp('alice')).toEqual(['p-research'])
  await experts.select(alice, first.id, true)
  await experts.publish(admin, first.id, false, await experts.revision())
  expect((await experts.owned('alice')).map(row => row.id)).toEqual([second.id])
  await experts.publish(admin, first.id, true, await experts.revision())
  expect((await experts.market(alice)).experts.find(row => row.id === first.id)?.status).toBe('available')
  await experts.grant(admin, 'members', [first.id], await experts.revision())
  expect((await experts.market(alice)).experts.find(row => row.id === first.id)?.status).toBe('granted')
  await expect(experts.select(alice, first.id, false)).rejects.toMatchObject({ code: 'expert-granted' })
  await experts.publish(admin, first.id, false, await experts.revision())
  expect((await experts.owned('bob')).map(row => row.id)).toEqual([first.id])
  await experts.grant(admin, 'members', [], await experts.revision())
  expect(await experts.owned('bob')).toEqual([])
  direct = ['research']
  await experts.publish(admin, second.id, false, await experts.revision())
  expect(await experts.owned('alice')).toEqual([])
  expect(await experts.mcp('alice')).toEqual([])
  expect((await effective.accessible('alice')).map(row => row.name)).toEqual(['research'])
  direct = []
  expect(await effective.accessible('alice')).toEqual([])
})

it('selects enabled shared models and resolves a current owned expert for a new conversation without exposing credentials', async () => {
  let state: ExpertState = { revision: 0, experts: [], grants: {}, selections: {} },
    enabled = true
  const accounts = ['admin', 'member'].map(username => ({
    username,
    spaceId: username,
    sessionEpoch: 0,
    email: '',
    admin: username === 'admin',
    groupId: username === 'admin' ? 'admins' : 'members',
    disabled: false,
    createdAt: 0,
    updatedAt: 0,
  }))
  const store = {
    get: async (name: string) => accounts.find(row => row.username === name),
    list: async () => accounts,
    listGroups: async () => [
      { id: 'admins', name: 'Admins', kind: 'admin' as const, memberCount: 1, isDefault: false },
      { id: 'members', name: 'Members', kind: 'ordinary' as const, memberCount: 1, isDefault: true },
    ],
  }
  const experts = new Experts(
    store,
    asyncExpertFacts({
      read: () => structuredClone(state),
      write: next => {
        state = structuredClone(next)
      },
    }),
    asyncSkillFacts({ list: () => [] }),
    asyncSkillFacts({ list: () => [] }),
    () => 'commerce',
    undefined,
    undefined,
    {
      status: () => ({
        state: 'ready',
        instance: { userId: 'member', origin: '', launchUrl: '', processId: 1, expertSnapshot: state.experts.map(row => `${row.id}:${row.revision}`) },
      }),
    },
    undefined,
    undefined,
    () => (enabled ? [{ providerId: 'provider-a', name: 'expert-model', id: 'opaque-model', label: 'Provider A / expert-model' }] : []),
  )
  const admin = { username: 'admin', spaceId: 'admin', sessionEpoch: 0 },
    member = { username: 'member', spaceId: 'member', sessionEpoch: 0 }
  const input = {
    name: 'Commerce',
    description: 'Marketing',
    icon: 'C',
    persona: 'Private persona',
    skills: [],
    skillPacks: [],
    model: { providerId: 'provider-a', name: 'expert-model' },
  }
  await experts.save(admin, input, await experts.revision())
  expect((await experts.list(admin)).experts[0]).toMatchObject({ model: input.model, modelLabel: 'Provider A / expert-model', modelUnavailable: false })
  await expect(experts.start(member, 'commerce')).rejects.toThrow('This expert is not available.')
  await experts.grant(admin, 'members', ['commerce'], await experts.revision())
  expect(await experts.start(member, 'commerce')).toEqual({ expertId: 'commerce', modelId: 'opaque-model' })
  await expect(experts.start({ ...member, sessionEpoch: 1 }, 'commerce')).rejects.toThrow('Sign in is required')
  enabled = false
  expect((await experts.list(admin)).models).toEqual([])
  expect((await experts.list(admin)).experts[0]).toMatchObject({ model: input.model, modelUnavailable: true })
  expect(await experts.start(member, 'commerce')).toEqual({ expertId: 'commerce', modelId: null })
  expect((await experts.market(member)).experts[0]).toMatchObject({ modelLabel: null })
  await expect(experts.save(admin, { ...input, model: { providerId: 'missing', name: 'missing' } }, await experts.revision())).rejects.toMatchObject({
    code: 'expert-invalid',
  })
  await experts.save(admin, { ...input, description: 'Updated' }, await experts.revision(), 'commerce')
  expect((await experts.list(admin)).experts[0]?.modelUnavailable).toBe(true)
  await experts.save(admin, { ...input, model: null }, await experts.revision(), 'commerce')
  expect((await experts.list(admin)).experts[0]?.modelUnavailable).toBe(false)
})

it('reports missing references, permits repairs and deletes an expert with its current ownership impact', async () => {
  let state: ExpertState = { revision: 0, experts: [], grants: {}, selections: {} },
    available = true
  const accounts = ['admin', 'alice', 'bob'].map(username => ({
    username,
    spaceId: username,
    sessionEpoch: 0,
    email: '',
    admin: username === 'admin',
    groupId: username === 'admin' ? 'admins' : 'members',
    disabled: false,
    createdAt: 0,
    updatedAt: 0,
  }))
  const accountStore = {
    get: async (name: string) => accounts.find(row => row.username === name),
    list: async () => accounts,
    listGroups: async () => [
      { id: 'admins', name: 'Admins', kind: 'admin' as const, memberCount: 1, isDefault: false },
      { id: 'members', name: 'Members', kind: 'ordinary' as const, memberCount: 2, isDefault: true },
    ],
  }
  const plugin = {
    packageName: 'expert-tool',
    version: '1.0.0',
    integrity: 'hash',
    artifact: 'artifact',
    runtimeRevision: 'runtime',
    title: 'Tool',
    description: '',
    dependencies: {},
    bundlePatch: '[]',
  }
  const current: CommunityUserInstance = {
    userId: 'alice',
    origin: 'http://localhost',
    launchUrl: 'http://localhost',
    processId: 1,
    inspection: 'checking',
    expertSnapshot: ['commerce:1'],
    expertFailures: [{ id: 'commerce', entries: ['preset'] }],
  }
  const experts = new Experts(
    accountStore,
    asyncExpertFacts({
      read: () => structuredClone(state),
      write: next => {
        state = structuredClone(next)
      },
    }),
    asyncSkillFacts({
      list: (): LibrarySkill[] => (available ? [{ name: 'research', description: 'Research', hash: 'research', importedAt: 0, published: false }] : []),
    }),
    asyncSkillFacts({ list: () => (available ? [{ name: 'methods', description: 'Methods', skills: [], instructions: '', published: false }] : []) }),
    () => 'commerce',
    undefined,
    undefined,
    { status: username => (username === 'alice' ? { state: 'ready', instance: current } : { state: 'stopped' }) },
    { list: async () => (available ? [{ ...plugin, current: plugin, stage: 'available' as const, published: false }] : []), eligible: () => true },
    async () => (available ? [{ name: 'p-research', description: 'Research MCP' }] : []),
  )
  const actor = (username: string) => ({ username, spaceId: username, sessionEpoch: 0 }),
    admin = actor('admin'),
    alice = actor('alice')
  const input = {
    name: 'Commerce',
    description: 'Marketing',
    icon: 'C',
    persona: 'Private persona',
    skills: ['research'],
    skillPacks: ['methods'],
    plugins: ['expert-tool'],
    mcp: ['p-research'],
  }
  await experts.save(admin, input, await experts.revision())
  await experts.publish(admin, 'commerce', true, await experts.revision())
  await experts.select(alice, 'commerce', true)
  available = false
  expect((await experts.list(admin)).experts[0]?.missing).toEqual(['mcp:p-research', 'plugin:expert-tool', 'skill-pack:methods', 'skill:research'])
  expect((await experts.market(alice)).experts[0]).toMatchObject({ partial: true, checking: true })
  expect((await experts.list(admin)).experts[0]).toMatchObject({ checking: ['alice'], failures: [{ username: 'alice', entries: ['preset'] }] })
  Object.assign(current, { inspection: 'complete' })
  expect((await experts.market(alice)).experts[0]?.checking).toBeUndefined()
  expect((await experts.market(alice)).experts[0]?.partial).toBe(true)
  expect(await experts.skills('alice')).toEqual([])
  expect(await experts.plugins('alice')).toEqual([])
  await experts.save(admin, { ...input, name: 'Repair later' }, await experts.revision(), 'commerce')
  await expect(experts.save(admin, { ...input, skills: ['new-missing'] }, await experts.revision(), 'commerce')).rejects.toMatchObject({
    code: 'expert-invalid',
  })
  await expect(experts.remove(alice, 'commerce', await experts.revision())).rejects.toMatchObject({ code: 'admin-required' })
  expect(await experts.impact(admin, 'commerce')).toMatchObject({ members: ['alice'], groups: [] })
  await experts.grant(admin, 'members', ['commerce'], await experts.revision())
  expect(await experts.impact(admin, 'commerce')).toMatchObject({ members: ['alice', 'bob'], groups: [{ id: 'members', name: 'Members' }] })
  await expect(experts.remove(admin, 'commerce', '0')).rejects.toMatchObject({ code: 'expert-stale' })
  const preview = await experts.impact(admin, 'commerce')
  accounts[2]!.disabled = true
  await expect(experts.remove(admin, 'commerce', preview.revision)).rejects.toMatchObject({ code: 'expert-stale' })
  await experts.remove(admin, 'commerce', (await experts.impact(admin, 'commerce')).revision)
  expect((await experts.market(alice)).experts).toEqual([])
  expect(await experts.owned('bob')).toEqual([])
  await experts.recover()
  expect((await experts.list(admin)).experts).toEqual([])
})

it.each(['recover', 'grant'])('preserves concurrent expert changes while %s waits for account groups', async operation => {
  let state: ExpertState = { revision: 0, experts: [], grants: { removed: [] }, selections: {} },
    serial = 0,
    pause = false
  let entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const actor = { username: 'admin', spaceId: 'admin', sessionEpoch: 0 }
  const account = { ...actor, admin: true, email: '', groupId: 'admins', disabled: false, createdAt: 0, updatedAt: 0 }
  const experts = new Experts(
    {
      get: async () => account,
      list: async () => [account],
      listGroups: async () => {
        if (pause) {
          entered()
          await gate
        }
        return [{ id: 'members', name: 'Members', kind: 'ordinary', isDefault: true, memberCount: 0 }]
      },
    },
    asyncExpertFacts({
      read: () => structuredClone(state),
      write: next => {
        state = structuredClone(next)
      },
    }),
    asyncSkillFacts({ list: () => [] }),
    asyncSkillFacts({ list: () => [] }),
    () => String(++serial),
  )
  const input = { name: 'Expert', description: 'Fixture', icon: '', persona: 'Help the member.', skills: [], skillPacks: [] }
  const original = await experts.save(actor, input, await experts.revision())
  pause = true
  const work = operation === 'recover' ? experts.recover() : experts.grant(actor, 'members', [original.id], await experts.revision())
  const result = work.then(
    () => undefined,
    error => error,
  )
  await began
  const added = await experts.save(actor, { ...input, name: 'Concurrent' }, await experts.revision())
  release()
  if (operation === 'grant') expect(await result).toMatchObject({ code: 'expert-stale' })
  else {
    expect(await result).toBeUndefined()
    expect(state.grants).not.toHaveProperty('removed')
  }
  expect(state.experts.map(row => row.id)).toContain(added.id)
})

it('refuses a stale expert save after asynchronous skill validation while preserving the other committed edit', async () => {
  const actor = { username: 'admin', spaceId: 'admin', sessionEpoch: 0 }
  const admin = { ...actor, admin: true, disabled: false, email: '', groupId: 'admins', createdAt: 0, updatedAt: 0 }
  let state: ExpertState = { revision: 0, experts: [], grants: {}, selections: {} },
    sequence = 0,
    pause = true
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => {
    enter = resolve
  })
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const service = new Experts(
    { get: async () => admin, list: async () => [admin], listGroups: async () => [] },
    asyncExpertFacts({
      read: () => structuredClone(state),
      write: value => {
        state = structuredClone(value)
      },
    }),
    {
      list: async () => {
        if (pause) {
          pause = false
          enter()
          await gate
        }
        return []
      },
    },
    { list: async () => [] },
    () => String(++sequence),
  )
  const revision = (await service.list(actor)).revision
  const input = { name: 'First', description: 'Role', icon: 'A', persona: 'Writes', skills: [], skillPacks: [] }
  const stale = service.save(actor, input, revision)
  try {
    await entered
    await service.save(actor, { ...input, name: 'Second' }, revision)
    release()
    await expect(stale).rejects.toMatchObject({ code: 'expert-stale' })
    expect(state.experts.map(row => row.name)).toEqual(['Second'])
    expect(state.revision).toBe(1)
  } finally {
    release()
    await stale.catch(() => {})
  }
})

it('attributes inspection and failures to the exact current expert preset revision', async () => {
  const admin = { username: 'admin', spaceId: 'admin', sessionEpoch: 0, admin: true, groupId: 'admins', disabled: false, email: '', createdAt: 0, updatedAt: 0 }
  const member = { ...admin, username: 'member', spaceId: 'member', admin: false, groupId: 'members' }
  let state: ExpertState = {
    revision: 1,
    experts: [
      {
        id: 'writer',
        revision: 1,
        published: true,
        name: 'Writer',
        description: 'Reports',
        icon: '',
        persona: 'Write reports.',
        skills: [],
        skillPacks: [],
        plugins: [],
        mcp: [],
        model: null,
        examples: [],
      },
    ],
    grants: { members: ['writer'] },
    selections: {},
  }
  const instance: CommunityUserInstance = {
    userId: 'member',
    origin: 'http://localhost',
    launchUrl: 'http://localhost',
    processId: 1,
    inspection: 'checking',
    expertSnapshot: ['writer:1'],
    expertFailures: [{ id: 'writer', entries: ['preset'] }],
  }
  const experts = new Experts(
    {
      get: async name => (name === 'admin' ? admin : member),
      list: async () => [admin, member],
      listGroups: async () => [{ id: 'members', name: 'Members', kind: 'ordinary', isDefault: true, memberCount: 1 }],
    },
    asyncExpertFacts({
      read: () => state,
      write: next => {
        state = next
      },
    }),
    asyncSkillFacts({ list: () => [] }),
    asyncSkillFacts({ list: () => [] }),
    () => 'unused',
    undefined,
    undefined,
    { status: username => (username === 'member' ? { state: 'ready', instance } : { state: 'stopped' }) },
  )
  expect((await experts.market(member)).experts[0]).toMatchObject({ partial: true, checking: true })
  const input = { name: 'Writer', description: 'Repaired reports', icon: '', persona: 'Write reports.', skills: [], skillPacks: [] }
  await experts.save(admin, input, await experts.revision(), 'writer')
  const market = await experts.market(member)
  expect(market.experts[0]).toMatchObject({ partial: false })
  expect(market.experts[0]?.checking).toBeUndefined()
  expect(market.pending).toBe(true)
  expect((await experts.list(admin)).experts[0]).toMatchObject({ failures: [], missing: [] })
  expect((await experts.list(admin)).experts[0]?.checking).toBeUndefined()
  await expect(experts.start(member, 'writer')).rejects.toMatchObject({ code: 'expert-restart-required' })
  Object.assign(instance, { expertSnapshot: ['writer:2'] })
  expect((await experts.market(member)).experts[0]).toMatchObject({ partial: true, checking: true })
  expect((await experts.list(admin)).experts[0]?.failures).toEqual([{ username: 'member', entries: ['preset'] }])
})
