import { expect, it } from 'vitest'
import { SkillMembership } from '../src/use-cases/skill-membership.js'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'

it('grants from the group, checks fresh impact and reconciles changes and retirement without instance actions', async () => {
  let accounts = [{ username: 'admin', spaceId: 'admin-space', groupId: 'admins', admin: true, disabled: false, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 }, { username: 'member', spaceId: 'member-space', groupId: 'ordinary', admin: false, disabled: false, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 }]
  let rows: LibrarySkill[] = [{ name: 'example', description: 'Example', hash: 'v1', importedAt: 0, published: false }]
  const groups = [{ id: 'admins', name: 'Admins', kind: 'admin' as const, isDefault: false, memberCount: 1 }, { id: 'ordinary', name: 'Members', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }]
  const reader = { get: (username: string) => accounts.find(account => account.username === username), list: () => accounts, listGroups: () => groups }
  const assignments = () => {
    let values: Record<string, readonly string[]> = {}
    return { get: (id: string) => values[id] ?? [], set: (id: string, names: readonly string[]) => { values[id] = names }, retain: (ids: readonly string[], names: readonly string[]) => { values = Object.fromEntries(Object.entries(values).filter(([id]) => ids.includes(id)).map(([id, selected]) => [id, selected.filter(name => names.includes(name))])) } }
  }
  const grants = assignments(), selections = assignments(), library = { list: () => rows }
  let failDistribution = false
  let projection: readonly { spaceId: string, skills: readonly LibrarySkill[] }[] = []
  const membership = new SkillMembership(reader, library, grants, selections, new MemberEffectiveSkills(reader, library, grants, selections), { synchronize: async value => { if (failDistribution) { projection = value.slice(0, 1); throw new Error('Disk full') }; projection = value } })
  expect(membership.impact('example')).toEqual({ managedMembers: 1, selectedMembers: 0 })
  const before = membership.group('ordinary')
  await membership.save('ordinary', ['example'], before.revision)
  expect(projection.map(member => [member.spaceId, member.skills.map(skill => skill.name)])).toEqual([['admin-space', ['example']], ['member-space', ['example']]])
  expect(membership.grantCount('ordinary')).toBe(1)
  await expect(membership.save('ordinary', [], before.revision)).rejects.toMatchObject({ code: 'skill-preview-changed' })
  await expect(membership.save('admins', [], membership.group('admins').revision)).rejects.toMatchObject({ code: 'group-protected' })
  await expect(membership.save('ordinary', ['missing'], membership.group('ordinary').revision)).rejects.toMatchObject({ code: 'skill-unavailable' })
  failDistribution = true
  await expect(membership.save('ordinary', [], membership.group('ordinary').revision)).rejects.toMatchObject({ code: 'skill-sync-failed' })
  expect(grants.get('ordinary')).toEqual([])
  expect(membership.synchronization()).toEqual({ pending: true })
  failDistribution = false
  await membership.reconcile()
  expect(membership.synchronization()).toEqual({ pending: false })
  expect(projection.find(member => member.spaceId === 'member-space')?.skills).toEqual([])
  await membership.save('ordinary', ['example'], membership.group('ordinary').revision)
  rows = []; await membership.reconcile()
  expect(grants.get('ordinary')).toEqual([])
  accounts = accounts.filter(account => account.username === 'admin'); await membership.reconcile()
  expect(projection.map(member => member.spaceId)).toEqual(['admin-space'])
})
