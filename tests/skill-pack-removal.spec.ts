import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FileSkillLibraryStore } from '../src/adapters/skill-library-store.js'
import { FileSkillPackStore } from '../src/adapters/skill-pack-store.js'
import { FileSkillAssignments } from '../src/adapters/skill-assignments.js'
import { SkillLibrary } from '../src/use-cases/skill-library.js'
import { SkillPacks } from '../src/use-cases/skill-packs.js'
import { SkillMembership } from '../src/use-cases/skill-membership.js'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
function setup(root: string, fault: { remove?: string } = {}) {
  const account = { ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }
  const accounts = { get: () => account, list: () => [account], listGroups: () => [
    { id: 'admins', name: 'Administrators', kind: 'admin' as const, isDefault: false, memberCount: 1 },
    { id: 'team', name: 'Team', kind: 'ordinary' as const, isDefault: true, memberCount: 0 }] }
  const persisted = new FileSkillLibraryStore(join(root, 'skills.json'))
  const store = { list: () => persisted.list(), save: persisted.save.bind(persisted), remove: (name: string) => {
    if (fault.remove === name) { delete fault.remove; throw new Error('Disk full') }
    persisted.remove(name)
  } }
  const assignments = (name: string) => new FileSkillAssignments(join(root, name + '.json'))
  const packs = { store: new FileSkillPackStore(join(root, 'packs.json')), grants: assignments('pack-grants'), selections: assignments('pack-selections') }
  const direct = assignments('grants'), choices = assignments('selections')
  const effective = new MemberEffectiveSkills(accounts, store, direct, choices, packs)
  const membership = new SkillMembership(accounts, store, direct, choices, effective, { synchronize: async () => {} }, undefined, packs)
  const artifacts = { accept: async () => { throw new Error('unused') }, read: async () => ({ markdown: '', files: [] }), collect: async () => {}, newToken: () => 'token' }
  const library = new SkillLibrary(accounts, store, artifacts, { now: () => 1 }, membership, undefined, [], packs)
  const service = new SkillPacks(accounts, store, packs, direct, library, { createNote: async () => { throw new Error('unused') } }, { now: () => 1 })
  return { store, library, service, direct }
}

it('resumes an approved cascading pack deletion after a child persistence failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-removal-')); roots.push(root)
  const fixture = setup(root, { remove: 'two' })
  for (const name of ['one', 'two', 'retained']) fixture.store.save({ name, description: name, hash: 'a'.repeat(64), importedAt: 0, published: true })
  fixture.direct.set('team', ['retained'])
  await fixture.service.save(actor, { name: 'bundle', description: 'Bundle', skills: ['one', 'two', 'retained'], instructions: '', published: true }, fixture.service.revision(actor))
  await expect(fixture.service.remove(actor, 'bundle', true, fixture.service.revision(actor))).rejects.toMatchObject({ code: 'skill-sync-failed' })
  expect(fixture.library.synchronization(actor)).toEqual({ pending: true })
  await fixture.library.retrySynchronization(actor)
  expect(fixture.service.list(actor)).toEqual([])
  expect(fixture.library.list(actor).map(skill => skill.name)).toEqual(['retained'])
  expect(fixture.library.synchronization(actor)).toEqual({ pending: false })
})

it('finishes persisted pack removal on restart before admitting another library change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-removal-')); roots.push(root)
  const initial = setup(root, { remove: 'two' })
  for (const name of ['one', 'two']) initial.store.save({ name, description: name, hash: 'a'.repeat(64), importedAt: 0, published: true })
  await initial.service.save(actor, { name: 'bundle', description: 'Bundle', skills: ['one', 'two'], instructions: '', published: true }, initial.service.revision(actor))
  await expect(initial.service.remove(actor, 'bundle', true, initial.service.revision(actor))).rejects.toMatchObject({ code: 'skill-sync-failed' })
  const restarted = setup(root)
  await restarted.library.recover()
  expect(restarted.service.list(actor)).toEqual([])
  expect(restarted.library.list(actor)).toEqual([])
  await restarted.library.recover()
  expect(restarted.library.synchronization(actor)).toEqual({ pending: false })
})

it('completes a pending deletion before checking the next pack mutation revision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-removal-')); roots.push(root)
  const fixture = setup(root, { remove: 'two' })
  for (const name of ['one', 'two']) fixture.store.save({ name, description: name, hash: 'a'.repeat(64), importedAt: 0, published: true })
  await fixture.service.save(actor, { name: 'bundle', description: 'Bundle', skills: ['one', 'two'], instructions: '', published: true }, fixture.service.revision(actor))
  await expect(fixture.service.remove(actor, 'bundle', true, fixture.service.revision(actor))).rejects.toMatchObject({ code: 'skill-sync-failed' })
  const stale = fixture.service.revision(actor)
  await expect(fixture.service.save(actor, { name: 'new-bundle', description: 'New bundle', skills: ['two'], instructions: '', published: true }, stale)).rejects.toMatchObject({ code: 'skill-preview-changed' })
  expect(fixture.service.list(actor)).toEqual([])
  expect(fixture.library.list(actor)).toEqual([])
})
