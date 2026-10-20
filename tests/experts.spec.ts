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
