import { postgresSkillService } from './fixtures/postgres-skill-service.js'
import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { createSkillStorage } from '../src/composition/skill-storage.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { openTestDatabase } from './support/community-application.js'
import type { PlatformDatabase } from '../src/adapters/platform-database.js'
import { SkillLibrary } from '../src/use-cases/skill-library.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'

it('imports immutable original bytes and extracted content, survives restart and collects only unreferenced versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-'))
  let database: PlatformDatabase | undefined, storage: ReturnType<typeof createSkillStorage> | undefined, service: SkillLibrary | undefined
  const zip = skillZip([
    { path: 'download/SKILL.md', content: validSkill },
    { path: 'download/_meta.json', content: 'opaque' },
  ])
  async function* bytes() {
    yield zip
  }
  const artifacts = new FileSkillArtifacts(join(root, 'artifacts'), [])
  try {
    database = await openTestDatabase(root)
    let accounts = new PostgresCommunityAccountStore(database)
    const actor = await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' })
    storage = createSkillStorage(database)
    await storage.initialize()
    service = new SkillLibrary(accounts, storage.library, artifacts, { now: () => 100 }, undefined, undefined, [], storage.packs, storage.work)
    const preview = await service.upload(actor, bytes(), new AbortController().signal)
    const row = await service.confirm(actor, preview.token, preview.revision)
    expect(await readFile(artifacts.directory(row.hash) + '/_meta.json', 'utf8')).toBe('opaque')
    expect(await readFile(artifacts.original(row.hash))).toEqual(zip)
    expect((await stat(artifacts.directory(row.hash) + '/SKILL.md')).mode & 0o222).toBe(0)
    await service.stop()
    await storage.close()
    await database.close()
    database = await openTestDatabase(root)
    accounts = new PostgresCommunityAccountStore(database)
    storage = createSkillStorage(database)
    await storage.initialize()
    const restart = new SkillLibrary(accounts, storage.library, artifacts, { now: () => 100 }, undefined, undefined, [], storage.packs, storage.work)
    service = restart
    await restart.recover()
    expect(await restart.detail(actor, row.name)).toMatchObject({ name: 'example-skill', markdown: validSkill, files: ['SKILL.md', '_meta.json'] })
    const duplicate = await restart.upload(actor, bytes(), new AbortController().signal)
    await restart.cancel(actor, duplicate.token)
    expect(await readFile(artifacts.original(row.hash))).toEqual(zip)
    await restart.remove(actor, row.name, (await restart.detail(actor, row.name)).revision)
    await expect(readFile(artifacts.original(row.hash))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await storage.library.list()).toEqual([])
  } finally {
    try {
      await service?.stop()
    } finally {
      try {
        await storage?.close()
      } finally {
        try {
          await database?.close()
        } finally {
          try {
            await artifacts.collect([])
          } finally {
            await rm(root, { recursive: true, force: true })
          }
        }
      }
    }
  }
})

it('interrupts stalled uploads without waiting for another network chunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-abort-'))
  const controller = new AbortController()
  let entered!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const content: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        entered()
        return new Promise(() => {})
      },
    }),
  }
  try {
    const receiving = new FileSkillArtifacts(root, []).accept(content, controller.signal)
    const assertion = expect(receiving).rejects.toMatchObject({ name: 'AbortError' })
    await started
    controller.abort()
    await assertion
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('retains chosen orchestration frontmatter and immutable files from multi-skill intake', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-import-artifacts-')),
    artifacts = new FileSkillArtifacts(root, [])
  const zip = skillZip([
    { path: 'a/SKILL.md', content: validSkill },
    { path: 'b/SKILL.md', content: validSkill.replace('example-skill', 'second') },
  ])
  async function* bytes() {
    yield zip
  }
  try {
    const preview = await artifacts.acceptImport(bytes(), new AbortController().signal)
    expect(preview.candidates.map(row => row.name)).toEqual(['example-skill', 'second'])
    const candidate = preview.candidates[0]!
    expect((await artifacts.read(candidate.hash)).markdown).toBe(validSkill)
    expect((await stat(artifacts.directory(candidate.hash) + '/SKILL.md')).mode & 0o222).toBe(0)
    const note = await artifacts.createNote(
      'renamed-note',
      'Note description',
      validSkill.replace('description: A useful skill', 'description: A useful skill\nuser-invocable: false'),
    )
    expect(note.markdown).toContain('name: renamed-note')
    expect(note.markdown.match(/---/gu)).toHaveLength(2)
    expect(note.markdown).toContain('user-invocable: false')
    const plain = await artifacts.createNote('plain-note', 'Plain note', '---\n# Steps\nRun one, then two.')
    expect(plain.markdown).toContain('name: plain-note')
    expect(plain.markdown).toContain('---\n# Steps\nRun one, then two.')
  } finally {
    await artifacts.collect([])
    await rm(root, { recursive: true, force: true })
  }
})

it('collects prepared but unregistered artifacts after a failed import and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-import-rollback-'))
  const artifacts = new FileSkillArtifacts(join(root, 'artifacts'), [])
  const fixture = await postgresSkillService(artifacts)
  const zip = skillZip(['one', 'two', 'workflow'].map(name => ({ path: name + '/SKILL.md', content: validSkill.replace('example-skill', name) })))
  async function* bytes() {
    yield zip
  }
  try {
    const preview = await fixture.library.previewImport(fixture.actor, bytes(), new AbortController().signal, 'workflow.zip')
    fixture.fault.commit = true
    await expect(
      fixture.library.confirmImport(fixture.actor, {
        token: preview.token,
        names: ['one', 'two'],
        replacements: [],
        packs: [{ name: 'workflow', description: 'Workflow', skills: ['one', 'two'], note: 'workflow' }],
      }),
    ).rejects.toThrow('commit failed')
    expect(await fixture.storage.library.list()).toEqual([])
    expect(await fixture.storage.packs.store.list()).toEqual([])
    await fixture.library.stop()
    const restarted = new FileSkillArtifacts(join(root, 'artifacts'), [])
    await restarted.recover()
    await restarted.collect([])
    for (const candidate of preview.candidates) await expect(restarted.read(candidate.hash)).rejects.toBeDefined()
  } finally {
    await fixture.close()
    await rm(root, { recursive: true, force: true })
  }
})
