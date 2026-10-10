import { expect, it } from 'vitest'
import { SkillLibrary } from '../src/use-cases/skill-library.js'
import { SkillMembership } from '../src/use-cases/skill-membership.js'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'

it('reconciles runtime name conflicts, disabled and deleted members without rewriting retained skill content', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let accounts = [actor, { username: 'member', spaceId: 'member-space', sessionEpoch: 0 }].map((row, index) => ({ ...row, admin: index === 0, groupId: index === 0 ? 'admin' : 'ordinary', disabled: false, email: '', createdAt: 0, updatedAt: 0 }))
  const reader = { get: (username: string) => accounts.find(row => row.username === username), list: () => accounts, listGroups: () => [{ id: 'admin', name: 'Admin', kind: 'admin' as const, isDefault: false, memberCount: 1 }, { id: 'ordinary', name: 'Ordinary', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }] }
  let rows: LibrarySkill[] = [{ name: 'example', description: 'Keep content', hash: 'unchanged', importedAt: 0, published: true }]
  const store = { list: () => rows, save: (row: LibrarySkill) => { rows = [row] }, remove: () => { rows = [] } }
  const assignments = () => { const map = new Map<string, readonly string[]>(); return { get: (id: string) => map.get(id) ?? [], set: (id: string, names: readonly string[]) => { map.set(id, names) }, retain: (ids: readonly string[], names: readonly string[]) => { for (const [id, values] of map) { if (!ids.includes(id)) map.delete(id); else map.set(id, values.filter(name => names.includes(name))) } } } }
  const grants = assignments(), selections = assignments(); selections.set('member-space', ['example'])
  const effective = new MemberEffectiveSkills(reader, store, grants, selections)
  let members: readonly { spaceId: string, skills: readonly LibrarySkill[] }[] = []
  const membership = new SkillMembership(reader, store, grants, selections, effective, { synchronize: async value => { members = value } })
  const create = (names: readonly string[]) => new SkillLibrary(reader, store, { accept: async () => { throw Error('unused') }, read: async () => ({ markdown: '# Keep', files: ['SKILL.md'] }), newToken: () => 'unused', collect: async () => {} }, { now: () => 0 }, membership, undefined, names)
  await create([]).recover(); expect(members.every(row => row.skills.length === 1)).toBe(true)
  const upgraded = create(['example']); await upgraded.recover()
  expect(upgraded.list(actor)[0]).toMatchObject({ name: 'example', conflict: true, hash: 'unchanged', published: true })
  expect(members.every(row => row.skills.length === 0)).toBe(true)
  expect(selections.get('member-space')).toEqual(['example'])
  const restored = create([]); await restored.recover()
  expect(restored.list(actor)[0]?.conflict).toBe(false)
  expect(members.every(row => row.skills.length === 1)).toBe(true)
  accounts[1]!.disabled = true; await restored.recover()
  expect(members.map(row => row.spaceId)).toEqual(['admin-space'])
  expect(selections.get('member-space')).toEqual(['example'])
  accounts[1]!.disabled = false; await restored.recover(); expect(members).toHaveLength(2)
  accounts = accounts.slice(0, 1); await restored.recover()
  expect(members.map(row => row.spaceId)).toEqual(['admin-space']); expect(selections.get('member-space')).toEqual([])
})
