import { FileSkillImportIntent } from '../src/adapters/skill-import-intent.js'
import { FileSkillPackStore } from '../src/adapters/skill-pack-store.js'
import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillLibraryStore } from '../src/adapters/skill-library-store.js'
import { SkillLibrary } from '../src/use-cases/skill-library.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'

it('imports immutable original bytes and extracted content, survives restart and collects only unreferenced versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-'))
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  const accounts = { get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) }
  const zip = skillZip([{ path: 'download/SKILL.md', content: validSkill }, { path: 'download/_meta.json', content: 'opaque' }])
  async function* bytes() { yield zip }
  try {
    const artifacts = new FileSkillArtifacts(join(root, 'artifacts'), [])
    const make = () => new SkillLibrary(accounts, new FileSkillLibraryStore(join(root, 'library.json')), artifacts, { now: () => 100 })
    const service = make()
    const preview = await service.upload(actor, bytes(), new AbortController().signal)
    const row = await service.confirm(actor, preview.token, preview.revision)
    expect(await readFile(artifacts.directory(row.hash) + '/_meta.json', 'utf8')).toBe('opaque')
    expect(await readFile(artifacts.original(row.hash))).toEqual(zip)
    expect((await stat(artifacts.directory(row.hash) + '/SKILL.md')).mode & 0o222).toBe(0)
    const restart = make(); await restart.recover()
    expect(await restart.detail(actor, row.name)).toMatchObject({ name: 'example-skill', markdown: validSkill, files: ['SKILL.md', '_meta.json'] })
    const duplicate = await restart.upload(actor, bytes(), new AbortController().signal)
    await restart.cancel(actor, duplicate.token)
    expect(await readFile(artifacts.original(row.hash))).toEqual(zip)
    await restart.remove(actor, row.name, (await restart.detail(actor, row.name)).revision)
    await expect(readFile(artifacts.original(row.hash))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(make().list(actor)).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('interrupts stalled uploads without waiting for another network chunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-abort-'))
  const controller = new AbortController()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const content: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => { entered(); return new Promise(() => {}) } }) }
  try {
    const receiving = new FileSkillArtifacts(root, []).accept(content, controller.signal)
    const assertion = expect(receiving).rejects.toMatchObject({ name: 'AbortError' })
    await started; controller.abort(); await assertion
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('retains chosen orchestration frontmatter and immutable files from multi-skill intake', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-import-artifacts-')), artifacts = new FileSkillArtifacts(root, [])
  const zip = skillZip([{ path: 'a/SKILL.md', content: validSkill }, { path: 'b/SKILL.md', content: validSkill.replace('example-skill', 'second') }])
  async function* bytes() { yield zip }
  try {
    const preview = await artifacts.acceptImport(bytes(), new AbortController().signal)
    expect(preview.candidates.map(row => row.name)).toEqual(['example-skill', 'second'])
    const candidate = preview.candidates[0]!
    expect((await artifacts.read(candidate.hash)).markdown).toBe(validSkill)
    expect((await stat(artifacts.directory(candidate.hash) + '/SKILL.md')).mode & 0o222).toBe(0)
    const note = await artifacts.createNote('renamed-note', 'Note description', validSkill.replace('description: A useful skill', 'description: A useful skill\nuser-invocable: false'))
    expect(note.markdown).toContain('name: renamed-note')
    expect(note.markdown.match(/---/gu)).toHaveLength(2)
    expect(note.markdown).toContain('user-invocable: false')
    const plain = await artifacts.createNote('plain-note', 'Plain note', '---\n# Steps\nRun one, then two.')
    expect(plain.markdown).toContain('name: plain-note')
    expect(plain.markdown).toContain('---\n# Steps\nRun one, then two.')
  } finally { await artifacts.collect([]); await rm(root, { recursive: true, force: true }) }
})


it('resumes an approved partial batch after restart and retains its generated note through shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-import-recovery-')), actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  const accounts = { get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) }
  const assignments = { get: () => [], set: () => {}, retain: () => {} }
  const artifacts = new FileSkillArtifacts(join(root, 'artifacts'), [])
  const zip = skillZip(['one', 'two', 'workflow'].map(name => ({ path: name + '/SKILL.md', content: validSkill.replace('example-skill', name) })))
  async function* bytes() { yield zip }
  let fail = true
  const make = () => {
    const store = new FileSkillLibraryStore(join(root, 'library.json'))
    const packs = { store: new FileSkillPackStore(join(root, 'packs.json')), grants: assignments, selections: assignments }
    return { packs, service: new SkillLibrary(accounts, { list: () => store.list(), remove: name => store.remove(name), save: row => { if (fail && row.name === 'two') throw new Error('Disk full'); store.save(row) } }, artifacts, { now: () => 100 }, undefined, undefined, [], packs, new FileSkillImportIntent(join(root, 'import-intent.json'))) }
  }
  try {
    const first = make(), preview = await first.service.previewImport(actor, bytes(), new AbortController().signal, 'workflow.zip')
    const input = { token: preview.token, names: ['one', 'two'], replacements: [], packs: [{ name: 'workflow', description: 'Workflow', skills: ['one', 'two'], note: 'workflow' }] }
    await expect(first.service.confirmImport(actor, input)).rejects.toMatchObject({ code: 'skill-sync-failed' })
    await first.service.stop()
    const restart = make()
    expect(restart.service.synchronization(actor)).toEqual({ pending: true })
    // Every mutation must finish the approved batch first, even after the preview is gone.
    await expect(restart.service.cancel(actor, 'unrelated')).rejects.toMatchObject({ code: 'skill-sync-failed' })
    fail = false; await restart.service.recover()
    expect(restart.service.list(actor).map(row => row.name)).toEqual(['one', 'two'])
    const note = restart.packs.store.list()[0]!.note!
    expect((await artifacts.read(note.hash)).markdown).toContain('name: workflow')
    expect(restart.service.synchronization(actor)).toEqual({ pending: false })
    await restart.service.confirmImport(actor, input)
    expect(make().service.list(actor)).toHaveLength(2)
    await restart.service.stop()
  } finally { await artifacts.collect([]); await rm(root, { recursive: true, force: true }) }
})
