import { expect, it } from 'vitest'
import { SkillLibrary } from '../src/use-cases/skill-library.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'

it('previews imported content before confirming a unique unpublished skill and replacing its current version', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  const account = { ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  const rows = new Map<string, LibrarySkill>()
  let serial = 0
  const service = new SkillLibrary({ get: () => account }, {
    list: () => [...rows.values()], save: row => { rows.set(row.name, row) }, remove: name => { rows.delete(name) },
  }, {
    accept: async () => ({ name: 'example-skill', description: 'Useful', hash: `hash-${++serial}`, markdown: '# Content', files: ['SKILL.md', '_meta.json'] }),
    read: async hash => ({ markdown: '# Content', files: ['SKILL.md', '_meta.json'], hash }),
    collect: async () => {}, newToken: () => `token-${serial}`,
  }, { now: () => 1000 })
  async function* bytes() { yield new Uint8Array([1]) }
  const preview = await service.upload(actor, bytes(), new AbortController().signal)
  expect(service.list(actor)).toEqual([])
  expect(preview).toMatchObject({ name: 'example-skill', replacing: false, markdown: '# Content', files: ['SKILL.md', '_meta.json'] })
  const skill = await service.confirm(actor, preview.token, preview.revision)
  expect(skill).toMatchObject({ name: 'example-skill', published: false, importedAt: 1000, managedMembers: 0, selectedMembers: 0 })
  expect(await service.detail(actor, 'example-skill')).toMatchObject({ markdown: '# Content', files: ['SKILL.md', '_meta.json'] })
  const replacement = await service.upload(actor, bytes(), new AbortController().signal)
  expect(replacement.replacing).toBe(true)
  expect(service.list(actor)[0]?.hash).toBe('hash-1')
  await service.confirm(actor, replacement.token, replacement.revision)
  expect(service.list(actor)).toHaveLength(1)
  expect(service.list(actor)[0]?.hash).toBe('hash-2')
})

it('requires current administrator identity and fresh impact, expires previews and confirms removal', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  let account = { ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  let now = 0, serial = 0
  const rows = new Map<string, LibrarySkill>()
  const service = new SkillLibrary({ get: () => account }, {
    list: () => [...rows.values()], save: row => { rows.set(row.name, row) }, remove: name => { rows.delete(name) },
  }, {
    accept: async () => ({ name: 'example-skill', description: 'Useful', hash: `hash-${++serial}`, markdown: '# Content', files: ['SKILL.md'] }),
    read: async () => ({ markdown: '# Content', files: ['SKILL.md'] }), collect: async () => {}, newToken: () => `token-${serial}`,
  }, { now: () => now })
  async function* bytes() { yield new Uint8Array([1]) }
  const upload = () => service.upload(actor, bytes(), new AbortController().signal)
  const first = await upload(), stale = await upload()
  await service.confirm(actor, first.token, first.revision)
  await expect(service.confirm(actor, stale.token, stale.revision)).rejects.toMatchObject({ code: 'skill-preview-changed' })
  const expired = await upload(); now = 31 * 60 * 1000
  await expect(service.confirm(actor, expired.token, expired.revision)).rejects.toMatchObject({ code: 'skill-preview-changed' })
  const revoked = await upload(); account = { ...account, sessionEpoch: 1 }
  await expect(service.confirm(actor, revoked.token, revoked.revision)).rejects.toMatchObject({ code: 'sign-in-required' })
  account = { ...account, sessionEpoch: 0, admin: false }
  expect(() => service.list(actor)).toThrow(expect.objectContaining({ code: 'admin-required' }))
  account = { ...account, admin: true }
  await expect(service.remove(actor, 'example-skill', 'old-impact')).rejects.toMatchObject({ code: 'skill-preview-changed' })
  const detail = await service.detail(actor, 'example-skill')
  await service.remove(actor, 'example-skill', detail.revision)
  expect(service.list(actor)).toEqual([])
  await service.stop()
  await expect(upload()).rejects.toMatchObject({ code: 'skill-unavailable' })
})

it('cancels in-flight intake on shutdown and never retains content after identity revocation', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  let account = { ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  let entered!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), release = new Promise<void>(resolve => { finish = resolve })
  let retained: readonly string[] = ['orphan']
  const service = new SkillLibrary({ get: () => account }, { list: () => [], save: () => {}, remove: () => {} }, {
    accept: async (_input, signal) => {
      entered()
      await Promise.race([release, new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))])
      return { name: 'example-skill', description: 'Useful', hash: 'orphan', markdown: '# Content', files: [] }
    }, read: async () => ({ markdown: '', files: [] }), collect: async hashes => { retained = hashes }, newToken: () => 'preview',
  }, { now: () => 0 })
  async function* bytes() { yield new Uint8Array([1]) }
  const uploading = service.upload(actor, bytes(), new AbortController().signal)
  const rejection = expect(uploading).rejects.toBeInstanceOf(Error)
  await started
  account = { ...account, sessionEpoch: 1 }; finish(); await rejection
  expect(retained).toEqual([])
  const second = new SkillLibrary({ get: () => ({ ...account, sessionEpoch: 0 }) }, { list: () => [], save: () => {}, remove: () => {} }, {
    accept: async (_input, signal) => { entered(); await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); throw new Error('unreachable') },
    read: async () => ({ markdown: '', files: [] }), collect: async () => {}, newToken: () => 'preview',
  }, { now: () => 0 })
  const anotherStarted = new Promise<void>(resolve => { entered = resolve })
  const secondUpload = second.upload(actor, bytes(), new AbortController().signal)
  const cancelled = expect(secondUpload).rejects.toThrow('aborted')
  await anotherStarted; await second.stop(); await cancelled
})
