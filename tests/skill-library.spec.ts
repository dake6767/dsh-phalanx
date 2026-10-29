import { asyncSkillFacts } from './fixtures/async-skill-facts.js'
import { expect, it } from 'vitest'
import { SkillLibrary } from './fixtures/skill-library.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'

it('previews imported content before confirming a unique unpublished skill and replacing its current version', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  const account = { ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  const rows = new Map<string, LibrarySkill>()
  let serial = 0
  const service = new SkillLibrary(
    { get: async () => account },
    asyncSkillFacts({
      list: async () => [...rows.values()],
      save: row => {
        rows.set(row.name, row)
      },
      remove: name => {
        rows.delete(name)
      },
    }),
    {
      accept: async () => ({
        name: 'example-skill',
        description: 'Useful',
        hash: `hash-${++serial}`,
        markdown: '# Content',
        files: ['SKILL.md', '_meta.json'],
      }),
      read: async hash => ({ markdown: '# Content', files: ['SKILL.md', '_meta.json'], hash }),
      collect: async () => {},
      newToken: () => `token-${serial}`,
    },
    { now: () => 1000 },
  )
  async function* bytes() {
    yield new Uint8Array([1])
  }
  const preview = await service.upload(actor, bytes(), new AbortController().signal)
  expect(await service.list(actor)).toEqual([])
  expect(preview).toMatchObject({ name: 'example-skill', replacing: false, markdown: '# Content', files: ['SKILL.md', '_meta.json'] })
  const skill = await service.confirm(actor, preview.token, preview.revision)
  expect(skill).toMatchObject({ name: 'example-skill', published: false, importedAt: 1000, managedMembers: 0, selectedMembers: 0 })
  expect(await service.detail(actor, 'example-skill')).toMatchObject({ markdown: '# Content', files: ['SKILL.md', '_meta.json'] })
  const replacement = await service.upload(actor, bytes(), new AbortController().signal)
  expect(replacement.replacing).toBe(true)
  expect((await service.list(actor))[0]?.hash).toBe('hash-1')
  await service.confirm(actor, replacement.token, replacement.revision)
  expect(await service.list(actor)).toHaveLength(1)
  expect((await service.list(actor))[0]?.hash).toBe('hash-2')
})

it('requires current administrator identity and fresh impact, expires previews and confirms removal', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  let account = { ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  let now = 0,
    serial = 0
  const rows = new Map<string, LibrarySkill>()
  const service = new SkillLibrary(
    { get: async () => account },
    asyncSkillFacts({
      list: async () => [...rows.values()],
      save: row => {
        rows.set(row.name, row)
      },
      remove: name => {
        rows.delete(name)
      },
    }),
    {
      accept: async () => ({ name: 'example-skill', description: 'Useful', hash: `hash-${++serial}`, markdown: '# Content', files: ['SKILL.md'] }),
      read: async () => ({ markdown: '# Content', files: ['SKILL.md'] }),
      collect: async () => {},
      newToken: () => `token-${serial}`,
    },
    { now: () => now },
  )
  async function* bytes() {
    yield new Uint8Array([1])
  }
  const upload = () => service.upload(actor, bytes(), new AbortController().signal)
  const first = await upload(),
    stale = await upload()
  await service.confirm(actor, first.token, first.revision)
  await expect(service.confirm(actor, stale.token, stale.revision)).rejects.toMatchObject({ code: 'skill-preview-changed' })
  const expired = await upload()
  now = 31 * 60 * 1000
  await expect(service.confirm(actor, expired.token, expired.revision)).rejects.toMatchObject({ code: 'skill-preview-changed' })
  const revoked = await upload()
  account = { ...account, sessionEpoch: 1 }
  await expect(service.confirm(actor, revoked.token, revoked.revision)).rejects.toMatchObject({ code: 'sign-in-required' })
  account = { ...account, sessionEpoch: 0, admin: false }
  await expect(service.list(actor)).rejects.toThrow(expect.objectContaining({ code: 'admin-required' }))
  account = { ...account, admin: true }
  await expect(service.remove(actor, 'example-skill', 'old-impact')).rejects.toMatchObject({ code: 'skill-preview-changed' })
  const detail = await service.detail(actor, 'example-skill')
  await service.remove(actor, 'example-skill', detail.revision)
  expect(await service.list(actor)).toEqual([])
  await service.stop()
  await expect(upload()).rejects.toMatchObject({ code: 'skill-unavailable' })
})

it('cancels in-flight intake on shutdown and never retains content after identity revocation', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  let account = { ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  let entered!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => {
      entered = resolve
    }),
    release = new Promise<void>(resolve => {
      finish = resolve
    })
  let retained: readonly string[] = ['orphan']
  const service = new SkillLibrary(
    { get: async () => account },
    asyncSkillFacts({ list: () => [], save: () => {}, remove: () => {} }),
    {
      accept: async (_input, signal) => {
        entered()
        await Promise.race([release, new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))])
        return { name: 'example-skill', description: 'Useful', hash: 'orphan', markdown: '# Content', files: [] }
      },
      read: async () => ({ markdown: '', files: [] }),
      collect: async hashes => {
        retained = hashes
      },
      newToken: () => 'preview',
    },
    { now: () => 0 },
  )
  async function* bytes() {
    yield new Uint8Array([1])
  }
  const uploading = service.upload(actor, bytes(), new AbortController().signal)
  const rejection = expect(uploading).rejects.toBeInstanceOf(Error)
  await started
  account = { ...account, sessionEpoch: 1 }
  finish()
  await rejection
  expect(retained).toEqual([])
  const second = new SkillLibrary(
    { get: async () => ({ ...account, sessionEpoch: 0 }) },
    asyncSkillFacts({ list: () => [], save: () => {}, remove: () => {} }),
    {
      accept: async (_input, signal) => {
        entered()
        await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
        throw new Error('unreachable')
      },
      read: async () => ({ markdown: '', files: [] }),
      collect: async () => {},
      newToken: () => 'preview',
    },
    { now: () => 0 },
  )
  const anotherStarted = new Promise<void>(resolve => {
    entered = resolve
  })
  const secondUpload = second.upload(actor, bytes(), new AbortController().signal)
  const cancelled = expect(secondUpload).rejects.toThrow('aborted')
  await anotherStarted
  await second.stop()
  await cancelled
})

it('preserves a contribution maintainer through administrator replacement and allows explicit transfer or clearing', async () => {
  const admin = {
    username: 'admin',
    spaceId: 'admin-space',
    sessionEpoch: 0,
    admin: true,
    disabled: false,
    groupId: 'admins',
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }
  const member = { ...admin, username: 'member', spaceId: 'member-space', admin: false },
    other = { ...member, username: 'other', spaceId: 'other-space' }
  let rows: LibrarySkill[] = [],
    hash = 'v1'
  const accounts = { get: async (name: string) => [admin, member, other].find(account => account.username === name) }
  const service = new SkillLibrary(
    accounts,
    asyncSkillFacts({
      list: async () => rows,
      save: async row => {
        rows = [structuredClone(row)]
      },
      remove: async () => {},
    }),
    {
      accept: async () => ({ name: 'guide', description: 'Guide', hash, markdown: '', files: ['SKILL.md'], fileHashes: { 'SKILL.md': hash } }),
      read: async () => ({ markdown: '', files: ['SKILL.md'] }),
      collect: async () => {},
      newToken: () => hash,
    },
    { now: () => 1 },
  )
  async function* bytes() {
    yield new Uint8Array()
  }
  const contribution = {
    name: 'guide',
    description: 'Guide',
    hash,
    markdown: '',
    files: ['SKILL.md'],
    fileHashes: { 'SKILL.md': hash },
    id: 'contribution',
    revision: 'revision',
    contributor: member,
    declaration: { purpose: 'Share' },
    submittedAt: 1,
    updatedAt: 1,
    status: 'pending' as const,
  }
  let preview = await service.upload(admin, bytes(), new AbortController().signal)
  await service.confirm(admin, preview.token, preview.revision, {
    id: contribution.id,
    revision: contribution.revision,
    committed: () => {},
    adoption: { row: contribution },
  })
  expect((await service.list(admin))[0]?.provenance?.maintainer?.username).toBe('member')
  hash = 'v2'
  preview = await service.upload(admin, bytes(), new AbortController().signal)
  await service.confirm(admin, preview.token, preview.revision)
  expect((await service.list(admin))[0]?.provenance?.maintainer?.username).toBe('member')
  expect((await service.list(admin))[0]?.provenance?.versions.map(row => row.source)).toEqual(['member', 'administrator'])
  let detail = (await service.list(admin))[0]!
  await service.setMaintainer(admin, 'guide', 'other', detail.maintenanceRevision!)
  await expect(service.setMaintainer(admin, 'guide', 'member', detail.maintenanceRevision!)).rejects.toMatchObject({ code: 'skill-preview-changed' })
  detail = (await service.list(admin))[0]!
  await service.setMaintainer(admin, 'guide', null, detail.maintenanceRevision!)
  expect((await service.list(admin))[0]?.provenance?.maintainer).toBeNull()
  await expect(service.setMaintainer(member, 'guide', 'member', (await service.list(admin))[0]!.maintenanceRevision!)).rejects.toMatchObject({
    code: 'admin-required',
  })
})

it('validates administrator dependency references, records them in the skill revision and preserves them on content replacement', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 },
    account = { ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  let row: LibrarySkill | undefined = { name: 'example', description: 'Example', hash: 'first', published: false, importedAt: 0 }
  const service = new SkillLibrary(
    { get: async () => account },
    asyncSkillFacts({
      list: async () => (row ? [row] : []),
      save: async value => {
        row = value
      },
      remove: async () => {
        row = undefined
      },
    }),
    {
      accept: async () => ({ name: 'example', description: 'Replacement', hash: 'second', markdown: '# Example', files: ['SKILL.md'] }),
      read: async () => ({ markdown: '# Example', files: ['SKILL.md'] }),
      collect: async () => {},
      newToken: () => 'token',
    },
    { now: () => 0 },
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    {
      readReady: async names => {
        if (names.some(name => name !== 'office')) throw Error('unavailable')
        return []
      },
    },
  )
  const detail = await service.detail(actor, 'example')
  await expect(service.setRuntimeDependencies(actor, 'example', ['missing'], detail.revision)).rejects.toThrow('unavailable')
  await service.setRuntimeDependencies(actor, 'example', ['office'], detail.revision)
  expect(row?.runtimeDependencies).toEqual(['office'])
  await expect(service.setRuntimeDependencies(actor, 'example', [], detail.revision)).rejects.toMatchObject({ code: 'skill-preview-changed' })
  const preview = await service.upload(
    actor,
    (async function* () {
      yield new Uint8Array()
    })(),
    new AbortController().signal,
  )
  await service.confirm(actor, preview.token, preview.revision)
  expect(row).toMatchObject({ hash: 'second', runtimeDependencies: ['office'] })
})
