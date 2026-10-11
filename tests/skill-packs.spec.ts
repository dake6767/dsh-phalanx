import { SkillMembership } from '../src/use-cases/skill-membership.js'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import { expect, it } from 'vitest'
import { SkillPacks } from '../src/use-cases/skill-packs.js'
import { SkillLibrary } from '../src/use-cases/skill-library.js'
import type { SkillPack } from '../src/domain/skill-pack.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'

it('creates ordered references and a note, previews conservative cascading deletion and rejects stale decisions', async () => {
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
  const members = [{ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 },
    { ...actor, username: 'member', spaceId: 'm', admin: false, groupId: 'team', disabled: false, email: '', createdAt: 0, updatedAt: 0 }]
  const accounts = { get: (name: string) => members.find(row => row.username === name), list: () => members, listGroups: () => [
    { id: 'admins', name: 'Administrators', kind: 'admin' as const, isDefault: false, memberCount: 1 },
    { id: 'team', name: 'Team', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }] }
  let failRename = false
  const assignments = () => { const rows = new Map<string, readonly string[]>(); return { get: (id: string) => rows.get(id) ?? [], set: (id: string, names: readonly string[]) => { if (failRename && names.includes('renamed')) { failRename = false; throw new Error('Disk full') }; rows.set(id, names) }, retain: () => {} } }
  const packRows = new Map<string, SkillPack>(), libraryRows = new Map<string, LibrarySkill>(['one', 'two', 'three'].map(name => [name, { name, description: name, hash: name, published: false, importedAt: 0 }]))
  const store = { list: () => [...libraryRows.values()], save: (row: LibrarySkill) => { libraryRows.set(row.name, row) }, remove: (name: string) => { libraryRows.delete(name) } }
  const packs = { store: { list: () => [...packRows.values()], save: (row: SkillPack) => { packRows.set(row.name, row) }, remove: (name: string) => { packRows.delete(name) } }, grants: assignments(), selections: assignments() }
  const direct = assignments(); direct.set('team', ['two'])
  const artifacts = { accept: async () => { throw new Error('unused') }, read: async () => ({ markdown: '', files: [] }), collect: async () => {}, newToken: () => 'token' }
  const choices = assignments(), effective = new MemberEffectiveSkills(accounts, store, direct, choices, packs)
  const membership = new SkillMembership(accounts, store, direct, choices, effective, { synchronize: async () => {} }, undefined, packs)
  const library = new SkillLibrary(accounts, store, artifacts, { now: () => 1 }, membership, undefined, [], packs)
  const service = new SkillPacks(accounts, store, packs, direct, library, { createNote: async (name, description, markdown) => ({ name, description, markdown, files: ['SKILL.md'], hash: 'note' }) }, { now: () => 1 }, [], choices)
  const input = { name: 'research', description: 'Research', skills: ['three', 'one', 'two'], instructions: 'Read one then two', published: true }
  await service.save(actor, input, service.revision(actor))
  expect(service.list(actor)[0]).toMatchObject({ ...input, empty: false })
  await service.save(actor, { ...input, name: 'other', skills: ['one'], instructions: '' }, service.revision(actor))
  packs.grants.set('team', ['research', 'other']); packs.selections.set('m', ['research', 'other'])
  failRename = true
  await expect(service.save(actor, { ...input, name: 'renamed', skills: ['one'], instructions: '' }, service.revision(actor), 'other')).rejects.toMatchObject({ code: 'skill-sync-failed' })
  await expect(service.save(actor, { ...input, name: 'renamed', skills: ['one'], instructions: '' }, service.revision(actor))).rejects.toMatchObject({ code: 'skill-preview-changed' })
  expect(service.list(actor).map(pack => pack.name)).toEqual(['research', 'renamed'])
  expect(packs.grants.get('team')).toEqual(['research', 'renamed'])
  expect(packs.selections.get('m')).toEqual(['research', 'renamed'])
  store.save({ ...store.list().find(row => row.name === 'one')!, conflict: true })
  const renamed = service.list(actor).find(pack => pack.name === 'renamed')!
  await service.save(actor, { name: renamed.name, description: 'Changed', skills: renamed.skills, instructions: '', published: true }, service.revision(actor))
  await expect(service.save(actor, { ...input, name: 'new-pack', skills: ['one'] }, service.revision(actor))).rejects.toMatchObject({ code: 'skill-pack-invalid' })
  store.save({ ...store.list().find(row => row.name === 'one')!, conflict: false })
  packs.selections.set('m', []); choices.set('m', ['three'])
  const directImpact = service.detail(actor, 'research')
  expect(directImpact.removal).toMatchObject({ selectedMembers: 0, selectedMembersWithSkills: 1 })
  choices.set('m', [])
  await expect(service.remove(actor, 'research', true, directImpact.revision)).rejects.toMatchObject({ code: 'skill-preview-changed' })
  packs.selections.set('m', ['research'])
  const preview = service.detail(actor, 'research')
  expect(preview.removal).toMatchObject({ deleting: ['three'], retained: [{ name: 'one', reasons: ['other-pack'] }, { name: 'two', reasons: ['direct-grant'] }], selectedMembers: 1 })
  expect(preview.removal.groups.map(group => group.id)).toContain('team')
  await expect(service.remove(actor, 'research', true, 'stale')).rejects.toMatchObject({ code: 'skill-preview-changed' })
  await service.remove(actor, 'research', true, preview.revision)
  expect(store.list().map(row => row.name)).toEqual(['one', 'two'])
  const one = await library.detail(actor, 'one'); expect(one.packs).toEqual(['renamed'])
  await library.remove(actor, 'one', one.revision)
  expect(service.list(actor)[0]).toMatchObject({ name: 'renamed', skills: [], empty: true })
  await expect(service.save({ ...actor, username: 'member', spaceId: 'm' }, input, '')).rejects.toMatchObject({ code: 'admin-required' })
})
