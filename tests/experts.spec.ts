import { expect, it } from 'vitest'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import { Experts } from '../src/use-cases/experts.js'
import type { ExpertState } from '../src/domain/expert.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'
import { YamlPluginAccessSyntax } from '../src/adapters/plugin-access-syntax.js'

it('admits expert skills and pack notes without global distribution, retaining independent grants after withdrawal', async () => {
  let state: ExpertState = { revision: 0, experts: [], grants: {}, selections: {} }
  let direct: string[] = []
  const accounts = ['admin', 'member'].map(username => ({ username, spaceId: username, sessionEpoch: 0, email: '', admin: username === 'admin', groupId: username === 'admin' ? 'admins' : 'members', disabled: false, createdAt: 0, updatedAt: 0 }))
  const accountStore = { get: (name: string) => accounts.find(row => row.username === name), list: () => accounts, listGroups: () => [
    { id: 'admins', name: 'Admins', kind: 'admin' as const, memberCount: 1, isDefault: false }, { id: 'members', name: 'Members', kind: 'ordinary' as const, memberCount: 1, isDefault: true },
  ] }
  const skill = (name: string): LibrarySkill => ({ name, description: name, hash: name, importedAt: 0, published: false })
  const library = { list: () => [skill('research'), skill('writing')] }
  const packs = { list: () => [{ name: 'marketing', description: 'Marketing', skills: ['writing'], instructions: 'Use writing', published: false, note: skill('marketing') }] }
  const plugin = { packageName: 'expert-tool', version: '1.0.0', integrity: 'hash', artifact: 'artifact', runtimeRevision: 'runtime', title: 'Tool', description: '', dependencies: {}, bundlePatch: JSON.stringify([{ id: 'tools', insert: [{ id: 'main', name: './main.js' }] }]) }
  const core = { ...plugin, packageName: 'core-tool', bundlePatch: JSON.stringify([{ id: 'web', config: {} }, { insert: [{ id: 'main', name: './main.js' }] }]) }
  const experts = new Experts(accountStore, { read: () => structuredClone(state), write: next => { state = structuredClone(next) } }, library, packs, () => 'commerce', undefined, undefined, undefined,
    { list: () => [plugin, core].map(current => ({ ...current, current, stage: 'available' as const, published: false })), eligible: plugin => new YamlPluginAccessSyntax().expertEligible(plugin) }, () => [{ name: 'p-research', description: 'Research MCP' }])
  const effective = new MemberEffectiveSkills(accountStore, library, { get: () => direct }, undefined, undefined, experts)
  const actor = { username: 'admin', spaceId: 'admin', sessionEpoch: 0 }
  const input = { name: 'Commerce', description: 'Marketing', icon: 'C', persona: 'Use marketing methods.', skills: ['research'], skillPacks: ['marketing'], plugins: ['expert-tool'], mcp: ['p-research'] }
  await expect(experts.save(actor, { ...input, plugins: ['core-tool'] }, '0')).rejects.toMatchObject({ code: 'expert-plugin-core-modification' })
  await expect(experts.save(actor, { ...input, mcp: ['p-missing'] }, '0')).rejects.toMatchObject({ code: 'expert-invalid' })
  await experts.save(actor, input, '0')
  expect(experts.list(actor).plugins).toEqual([{ packageName: 'expert-tool', title: 'Tool', eligible: true }, { packageName: 'core-tool', title: 'Tool', eligible: false }])
  expect(experts.list(actor).mcp).toEqual([{ name: 'p-research', description: 'Research MCP' }])
  expect(experts.owned('member')).toEqual([])
  expect(experts.owned('admin').map(row => row.id)).toEqual(['commerce'])
  await expect(experts.grant({ username: 'member', spaceId: 'member', sessionEpoch: 0 }, 'members', ['commerce'], experts.revision())).rejects.toMatchObject({ code: 'admin-required' })
  await expect(experts.grant(actor, 'members', ['commerce'], '0')).rejects.toMatchObject({ code: 'expert-stale' })
  await expect(experts.grant(actor, 'admins', [], experts.revision())).rejects.toThrow()
  await experts.grant(actor, 'members', ['commerce'], experts.revision())
  expect(experts.plugins('member')).toEqual([plugin])
  expect(experts.mcp('member')).toEqual(['p-research'])
  expect(effective.effective('member')).toEqual([])
  expect(effective.accessible('member').map(row => row.name)).toEqual(['marketing', 'research', 'writing'])
  direct = ['research']
  expect(effective.effective('member').map(row => row.skill.name)).toEqual(['research'])
  await experts.grant(actor, 'members', [], experts.revision())
  expect(experts.plugins('member')).toEqual([])
  expect(experts.mcp('member')).toEqual([])
  expect(effective.accessible('member').map(row => row.name)).toEqual(['research'])
  accounts[1]!.disabled = true
  expect(effective.accessible('member')).toEqual([])
})

it('unions published summons by member space with grants, clears unpublished summons and retains independent capability sources', async () => {
  let state: ExpertState = { revision: 0, experts: [], grants: {}, selections: {} }, sequence = 0
  let direct: string[] = []
  const accounts = ['admin', 'alice', 'bob'].map(username => ({ username, spaceId: username + '-space', sessionEpoch: 0, email: '', admin: username === 'admin', groupId: username === 'admin' ? 'admins' : 'members', disabled: false, createdAt: 0, updatedAt: 0 }))
  const accountStore = { get: (name: string) => accounts.find(row => row.username === name), list: () => accounts, listGroups: () => [
    { id: 'admins', name: 'Admins', kind: 'admin' as const, memberCount: 1, isDefault: false }, { id: 'members', name: 'Members', kind: 'ordinary' as const, memberCount: 2, isDefault: true },
  ] }
  const library = { list: (): readonly LibrarySkill[] => [{ name: 'research', description: 'Research', hash: 'research', importedAt: 0, published: false }] }
  const plugin = { packageName: 'expert-tool', version: '1.0.0', integrity: 'hash', artifact: '/private/artifact', runtimeRevision: 'runtime', title: 'Tool', description: '', dependencies: {}, bundlePatch: '[]' }
  const experts = new Experts(accountStore, { read: () => structuredClone(state), write: next => { state = structuredClone(next) } }, library, { list: () => [] }, () => 'expert-' + ++sequence, undefined, undefined, undefined,
    { list: () => [{ ...plugin, current: plugin, stage: 'available' as const, published: false }], eligible: () => true }, () => [{ name: 'p-research', description: 'Research MCP' }])
  const actor = (username: string) => ({ username, spaceId: username + '-space', sessionEpoch: 0 })
  const admin = actor('admin'), alice = actor('alice'), bob = actor('bob')
  const input = { name: 'Commerce', description: 'Marketing', icon: 'C', persona: 'Private persona', skills: ['research'], skillPacks: [], plugins: ['expert-tool'], mcp: ['p-research'], examples: ['Plan a launch', 'Review a campaign'] }
  const first = await experts.save(admin, input, experts.revision())
  expect(first.examples).toEqual(input.examples)
  await expect(experts.save(admin, { ...input, examples: ['Only one'] }, experts.revision())).rejects.toMatchObject({ code: 'expert-invalid' })
  expect(() => experts.market({ ...alice, sessionEpoch: 1 })).toThrow('Sign in is required')
  await expect(experts.select({ ...alice, spaceId: 'another-space' }, first.id, true)).rejects.toMatchObject({ code: 'sign-in-required' })
  expect(experts.market(alice).experts).toEqual([])
  await expect(experts.select(alice, first.id, true)).rejects.toMatchObject({ code: 'expert-unavailable' })
  await expect(experts.publish(alice, first.id, true, experts.revision())).rejects.toMatchObject({ code: 'admin-required' })
  await expect(experts.publish(admin, first.id, true, '0')).rejects.toMatchObject({ code: 'expert-stale' })
  await experts.publish(admin, first.id, true, experts.revision())
  expect(experts.owned('alice')).toEqual([])
  expect(experts.market(alice).experts[0]).toMatchObject({ id: first.id, status: 'available', examples: input.examples, plugins: ['expert-tool'] })
  expect(JSON.stringify(experts.market(alice))).not.toContain('Private persona'); expect(JSON.stringify(experts.market(alice))).not.toContain('/private/artifact')
  expect(await experts.select(alice, first.id, true)).toMatchObject({ application: 'restart-required' })
  expect(experts.market(alice).experts[0]?.status).toBe('summoned')
  expect(experts.mcp('alice')).toEqual(['p-research'])
  expect(experts.market(bob).experts[0]?.status).toBe('available')
  accounts[1]!.spaceId = 'replacement-space'; expect(experts.owned('alice')).toEqual([]); accounts[1]!.spaceId = alice.spaceId
  await experts.recover(); expect(experts.owned('alice').map(row => row.id)).toEqual([first.id])
  const effective = new MemberEffectiveSkills(accountStore, library, { get: () => direct }, undefined, undefined, experts)
  expect(effective.effective('alice')).toEqual([]); expect(effective.accessible('alice').map(row => row.name)).toEqual(['research'])
  const second = await experts.save(admin, { ...input, name: 'Writer' }, experts.revision())
  await experts.publish(admin, second.id, true, experts.revision()); await experts.select(alice, second.id, true)
  await experts.select(alice, first.id, false)
  expect(experts.owned('alice').map(row => row.id)).toEqual([second.id]); expect(experts.plugins('alice')).toEqual([plugin]); expect(experts.mcp('alice')).toEqual(['p-research'])
  await experts.select(alice, first.id, true)
  await experts.publish(admin, first.id, false, experts.revision())
  expect(experts.owned('alice').map(row => row.id)).toEqual([second.id])
  await experts.publish(admin, first.id, true, experts.revision())
  expect(experts.market(alice).experts.find(row => row.id === first.id)?.status).toBe('available')
  await experts.grant(admin, 'members', [first.id], experts.revision())
  expect(experts.market(alice).experts.find(row => row.id === first.id)?.status).toBe('granted')
  await expect(experts.select(alice, first.id, false)).rejects.toMatchObject({ code: 'expert-granted' })
  await experts.publish(admin, first.id, false, experts.revision())
  expect(experts.owned('bob').map(row => row.id)).toEqual([first.id])
  await experts.grant(admin, 'members', [], experts.revision()); expect(experts.owned('bob')).toEqual([])
  direct = ['research']; await experts.publish(admin, second.id, false, experts.revision())
  expect(experts.owned('alice')).toEqual([]); expect(experts.mcp('alice')).toEqual([]); expect(effective.accessible('alice').map(row => row.name)).toEqual(['research'])
  direct = []; expect(effective.accessible('alice')).toEqual([])
})

it('selects enabled shared models and resolves a current owned expert for a new conversation without exposing credentials', async () => {
  let state: ExpertState = { revision: 0, experts: [], grants: {}, selections: {} }, enabled = true
  const accounts = ['admin', 'member'].map(username => ({ username, spaceId: username, sessionEpoch: 0, email: '', admin: username === 'admin', groupId: username === 'admin' ? 'admins' : 'members', disabled: false, createdAt: 0, updatedAt: 0 }))
  const store = { get: (name: string) => accounts.find(row => row.username === name), list: () => accounts, listGroups: () => [
    { id: 'admins', name: 'Admins', kind: 'admin' as const, memberCount: 1, isDefault: false }, { id: 'members', name: 'Members', kind: 'ordinary' as const, memberCount: 1, isDefault: true },
  ] }
  const experts = new Experts(store, { read: () => structuredClone(state), write: next => { state = structuredClone(next) } }, { list: () => [] }, { list: () => [] }, () => 'commerce', undefined, undefined,
    { status: () => ({ state: 'ready', instance: { userId: 'member', origin: '', launchUrl: '', processId: 1, expertSnapshot: state.experts.map(row => `${row.id}:${row.revision}`) } }) }, undefined, undefined,
    () => enabled ? [{ providerId: 'provider-a', name: 'expert-model', id: 'opaque-model', label: 'Provider A / expert-model' }] : [])
  const admin = { username: 'admin', spaceId: 'admin', sessionEpoch: 0 }, member = { username: 'member', spaceId: 'member', sessionEpoch: 0 }
  const input = { name: 'Commerce', description: 'Marketing', icon: 'C', persona: 'Private persona', skills: [], skillPacks: [], model: { providerId: 'provider-a', name: 'expert-model' } }
  await experts.save(admin, input, '0')
  expect(experts.list(admin).experts[0]).toMatchObject({ model: input.model, modelLabel: 'Provider A / expert-model', modelUnavailable: false })
  expect(() => experts.start(member, 'commerce')).toThrow('This expert is not available.')
  await experts.grant(admin, 'members', ['commerce'], experts.revision())
  expect(experts.start(member, 'commerce')).toEqual({ agentPreset: 'phalanx-expert-commerce', model: { provider: 'deepseek-official', model: 'opaque-model' } })
  expect(() => experts.start({ ...member, sessionEpoch: 1 }, 'commerce')).toThrow('Sign in is required')
  enabled = false
  expect(experts.list(admin).models).toEqual([])
  expect(experts.list(admin).experts[0]).toMatchObject({ model: input.model, modelUnavailable: true })
  expect(experts.start(member, 'commerce')).toEqual({ agentPreset: 'phalanx-expert-commerce', model: null })
  expect(experts.market(member).experts[0]).toMatchObject({ modelLabel: null })
  await expect(experts.save(admin, { ...input, model: { providerId: 'missing', name: 'missing' } }, experts.revision())).rejects.toMatchObject({ code: 'expert-invalid' })
  await experts.save(admin, { ...input, description: 'Updated' }, experts.revision(), 'commerce')
  expect(experts.list(admin).experts[0]?.modelUnavailable).toBe(true)
  await experts.save(admin, { ...input, model: null }, experts.revision(), 'commerce')
  expect(experts.list(admin).experts[0]?.modelUnavailable).toBe(false)
})
