import type { SkillImportIntent } from '../src/ports/skill-import-intent.js'
import { expect, it } from 'vitest'
import { SkillLibrary } from '../src/use-cases/skill-library.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'
import type { SkillPack } from '../src/domain/skill-pack.js'

it('holds a candidate set for review, requires each replacement and imports the selected orchestration as a pack note', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  const rows = new Map<string, LibrarySkill>([['one', { name: 'one', description: 'Old', hash: 'old', published: true, importedAt: 0 }]])
  let intent: SkillImportIntent | undefined, failSkill = false, failPack = false
  const journal = { get: () => intent, save: (value: SkillImportIntent) => { intent = value }, clear: () => { intent = undefined } }
  const packs = new Map<string, SkillPack>(); let retained: readonly string[] = []
  const assignments = { get: () => [], set: () => {}, retain: () => {} }
  const candidates = ['one', 'two', 'workflow'].map(name => ({ name, description: name, hash: name, markdown: '# ' + name, files: ['SKILL.md'], path: name, internal: false, orchestration: name === 'workflow', warnings: [] }))
  const service = new SkillLibrary({ get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }) },
    { list: () => [...rows.values()], save: row => { if (failSkill && row.name === 'two') { failSkill = false; throw new Error('Disk full') }; rows.set(row.name, row) }, remove: name => { rows.delete(name) } },
    { accept: async () => { throw new Error('unused') }, acceptImport: async () => ({ candidates, packs: [] }),
      createNote: async (name, description, markdown) => ({ name, description, markdown, files: ['SKILL.md'], hash: 'note' }),
      read: async () => ({ markdown: '', files: [] }), newToken: () => 'token', collect: async value => { retained = value } }, { now: () => 1 }, undefined, undefined, [],
    { store: { list: () => [...packs.values()], save: row => { if (failPack) { failPack = false; throw new Error('Disk full') }; packs.set(row.name, row) }, remove: name => { packs.delete(name) } }, grants: assignments, selections: assignments }, journal)
  async function* bytes() { yield new Uint8Array([1]) }
  const preview = await service.previewImport(actor, bytes(), new AbortController().signal, 'bundle.zip')
  expect(service.list(actor)).toHaveLength(1)
  expect(retained).toEqual(expect.arrayContaining(['old', 'one', 'two', 'workflow']))
  expect(preview).toMatchObject({ defaultPackName: 'workflow', candidates: [expect.objectContaining({ name: 'one', replacing: true }), expect.anything(), expect.anything()] })
  const selected = { token: preview.token, names: ['one', 'two'], replacements: [], packs: [{ name: 'workflow', description: 'Workflow', skills: ['two', 'one'], note: 'workflow' }] }
  await expect(service.confirmImport(actor, selected)).rejects.toMatchObject({ code: 'skill-preview-changed' })
  failSkill = true; failPack = true
  await expect(service.confirmImport(actor, { ...selected, replacements: ['one'] })).rejects.toMatchObject({ code: 'skill-sync-failed' })
  expect(service.synchronization(actor)).toEqual({ pending: true })
  expect(retained).toContain('note')
  await expect(service.confirmImport(actor, { ...selected, replacements: ['one'] })).rejects.toMatchObject({ code: 'skill-sync-failed' })
  await service.confirmImport(actor, { ...selected, replacements: ['one'] })
  expect(service.list(actor).map(row => [row.name, row.published])).toEqual([['one', true], ['two', false]])
  expect(packs.get('workflow')).toMatchObject({ skills: ['two', 'one'], note: { hash: 'note' }, instructions: '# workflow' })
  expect(retained).toEqual(expect.arrayContaining(['one', 'two', 'note']))
  expect(retained).not.toContain('workflow')
  expect(retained).not.toContain('old')
  await service.confirmImport(actor, { ...selected, replacements: ['one'] })
  const cancelled = await service.previewImport(actor, bytes(), new AbortController().signal, 'bundle.zip')
  await service.cancel(actor, cancelled.token)
  await expect(service.confirmImport(actor, { ...selected, token: cancelled.token, replacements: ['one'] })).rejects.toMatchObject({ code: 'skill-preview-changed' })
  expect(retained).not.toContain('workflow')
})
