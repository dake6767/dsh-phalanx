import { expect, it } from 'vitest'
import { SkillLibrary } from '../src/use-cases/skill-library.js'
import { SkillMembership } from '../src/use-cases/skill-membership.js'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'

it('publishes reviewed skills, applies member choices and clears selections on unpublish while preserving managed grants', async () => {
  const admin = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }, member = { username: 'member', spaceId: 'member-space', sessionEpoch: 0 }
  let moveWhileReading = false
  let disabled = false, overrides: string[] = []
  const accounts = [admin, member].map(actor => ({ ...actor, admin: actor === admin, groupId: actor === admin ? 'admins' : 'ordinary', disabled: false, email: '', createdAt: 0, updatedAt: 0 }))
  const reader = { get: (username: string) => { const account = accounts.find(row => row.username === username); return account ? { ...account, disabled } : undefined }, list: () => accounts, listGroups: () => [{ id: 'admins', name: 'Admins', kind: 'admin' as const, isDefault: false, memberCount: 1 }, { id: 'ordinary', name: 'Members', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }] }
  let rows: LibrarySkill[] = [{ name: 'example', description: 'Example', hash: 'v1', importedAt: 0, published: false }]
  const store = { list: () => rows, save: (row: LibrarySkill) => { rows = [row] }, remove: () => { rows = [] } }
  const assignments = () => { const map = new Map<string, readonly string[]>(); return { get: (id: string) => map.get(id) ?? [], set: (id: string, names: readonly string[]) => { map.set(id, names) }, retain: (ids: readonly string[], names: readonly string[]) => { for (const [id, values] of map) map.set(id, ids.includes(id) ? values.filter(name => names.includes(name)) : []) } } }
  const grants = assignments(), selections = assignments(), effective = new MemberEffectiveSkills(reader, store, grants, selections)
  let distributed: readonly { spaceId: string, skills: readonly LibrarySkill[] }[] = []
  const membership = new SkillMembership(reader, store, grants, selections, effective, { synchronize: async value => { distributed = value } })
  const service = new SkillLibrary(reader, store, { accept: async () => { throw Error('unused') }, read: async () => { if (moveWhileReading) accounts[1]!.groupId = 'removed-group'; return { markdown: '# Review', files: ['SKILL.md'] } }, collect: async () => {}, newToken: () => 'unused' }, { now: () => 0 }, membership, { names: async () => overrides })
  expect((await service.market(member)).skills).toEqual([])
  await expect(service.select(member, 'example', true)).rejects.toMatchObject({ code: 'skill-unavailable' })
  await expect(service.publish(member, 'example', true, '')).rejects.toMatchObject({ code: 'admin-required' })
  const detail = await service.detail(admin, 'example')
  await service.publish(admin, 'example', true, detail.revision)
  expect((await service.market(member)).skills[0]).toMatchObject({ status: 'install', source: null })
  expect(await service.marketDetail(member, 'example')).toMatchObject({ markdown: '# Review' })
  const beforeSelection = await service.detail(admin, 'example')
  await service.select(member, 'example', true)
  expect((await service.market(member)).skills[0]).toMatchObject({ status: 'selected', source: 'selected' })
  expect(distributed.find(row => row.spaceId === member.spaceId)?.skills).toHaveLength(1)
  await expect(service.publish(admin, 'example', false, beforeSelection.revision)).rejects.toMatchObject({ code: 'skill-preview-changed' })
  overrides = ['example']; expect((await service.market(member)).skills[0]).toMatchObject({ status: 'overridden', source: 'selected' })
  grants.set('ordinary', ['example']); expect((await service.market(member)).skills[0]).toMatchObject({ status: 'overridden', source: 'managed' })
  await expect(service.select(member, 'example', false)).rejects.toMatchObject({ code: 'skill-unavailable' })
  await service.publish(admin, 'example', false, (await service.detail(admin, 'example')).revision)
  expect(selections.get(member.spaceId)).toEqual([])
  expect(effective.effective(member.username)[0]?.source).toBe('managed')
  grants.set('ordinary', []); expect((await service.market(member)).skills).toEqual([])
  await service.publish(admin, 'example', true, (await service.detail(admin, 'example')).revision)
  expect((await service.market(member)).skills[0]?.source).toBeNull()
  await service.select(member, 'example', true); await service.select(member, 'example', false)
  expect(effective.effective(member.username)).toEqual([])
  grants.set('ordinary', ['example'])
  await service.publish(admin, 'example', false, (await service.detail(admin, 'example')).revision)
  moveWhileReading = true
  await expect(service.marketDetail(member, 'example')).rejects.toMatchObject({ code: 'skill-unavailable' })
  disabled = true; await expect(service.market(member)).rejects.toMatchObject({ code: 'sign-in-required' })
})
