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
