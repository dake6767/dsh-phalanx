import { expect, it } from 'vitest'
import { join } from 'node:path'
import { discoverSkillFiles } from '../src/adapters/skill-import.js'
import { symlink } from 'node:fs/promises'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { GitSkillRepository } from '../src/adapters/skill-git.js'
import { FileContributionArtifacts } from '../src/adapters/contribution-storage.js'
import { SkillLibrary } from '../src/use-cases/skill-library.js'
import { MemberContributions } from '../src/use-cases/member-contributions.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'
import { memoryContributions, fakeContributionLibrary } from './fixtures/contributions.js'
import { gitFixture } from './fixtures/skills/git-repository.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'

it('admits the same larger skill only through catalog staging, without granting later ordinary imports its limits', async () => {
  const f = await gitFixture(), signal = new AbortController().signal
  const content = 'x'.repeat(21 * 1024 * 1024)
  const commit = await f.commit({ 'SKILL.md': validSkill, 'templates/large.txt': content })
  const artifacts = new FileSkillArtifacts(join(f.root, 'artifacts'), [], new GitSkillRepository(join(f.root, 'imports'), f))
  const actor = { username: 'admin', spaceId: 'admin', sessionEpoch: 0 }
  const accounts = { get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }) }
  const rows = new Map<string, LibrarySkill>()
  const library = new SkillLibrary(accounts, { list: () => [...rows.values()], save: row => { rows.set(row.name, row) }, remove: name => { rows.delete(name) } }, artifacts, { now: () => 1 }, undefined, undefined, [], undefined, { get: () => undefined, save: () => {}, clear: () => {} })
  async function* upload() { yield skillZip([{ path: 'SKILL.md', content: validSkill }, { path: 'templates/large.txt', content }]) }
  const ordinaryError = { code: 'skill-upload-too-large', params: { reason: 'The extracted skill must be at most 20 MB.' } }
  try {
    await expect(library.prepareSuiteImport('suite:large', { url: f.url, ref: commit, subpath: '' }, ['example-skill'], async () => {}, signal)).resolves.toBeUndefined()
    const [row] = await library.commitSuiteSkills('suite:large')
    expect(row?.source).toMatchObject({ commit, url: f.url, path: '' })
    expect(row?.source?.contentHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(row?.hash).not.toBe(row?.source?.contentHash)
    await expect(library.previewGit(actor, f.url + '#' + commit, signal)).rejects.toMatchObject(ordinaryError)
    await library.detachSuiteSkill('suite:large', 'example-skill')
    await expect(library.previewGit(actor, '', signal, 'example-skill')).rejects.toMatchObject(ordinaryError)
    await expect(library.upload(actor, upload(), signal)).rejects.toMatchObject(ordinaryError)
    const contributions = new MemberContributions(accounts, memoryContributions(), new FileContributionArtifacts(join(f.root, 'contributions'), []), fakeContributionLibrary(), { now: () => 1 })
    await expect(contributions.submit(actor, { purpose: 'Share templates' }, upload(), signal)).rejects.toMatchObject(ordinaryError)
  } finally { await library.stop(); await artifacts.collect([]); await f.close() }
}, 30000)

it('counts catalog files separately from directories, accepts 16384, and keeps the ordinary 10000-path rejection', async () => {
  const f = await gitFixture(), signal = new AbortController().signal
  const files: Record<string, string> = { 'SKILL.md': validSkill }
  for (let i = 0; i < 16383; i++) files[`templates/d${i}/resource.txt`] = 'x'
  try {
    const commit = await f.commit(files), adapter = new GitSkillRepository(join(f.root, 'imports'), f), source = { url: f.url, ref: commit, subpath: '' }
    await expect(adapter.read(source, signal)).rejects.toMatchObject({ code: 'skill-archive-invalid', params: { reason: 'The repository contains too many files.' } })
    expect((await adapter.read(source, signal, 'catalog')).files).toHaveLength(16384)
    const over = await f.commit({ 'extra.txt': 'x' })
    await expect(adapter.read({ ...source, ref: over }, signal, 'catalog')).rejects.toMatchObject({ code: 'skill-catalog-limit-exceeded' })
    const upload = skillZip(Object.entries(files).slice(0, 10001).map(([path, content]) => ({ path, content })))
    await expect(new FileSkillArtifacts(join(f.root, 'uploads'), []).accept((async function* () { yield upload })(), signal)).rejects.toMatchObject({ code: 'skill-archive-invalid' })
    const member = { username: 'member', spaceId: 'member', sessionEpoch: 0 }
    const accounts = { get: () => ({ ...member, admin: false, disabled: false, groupId: 'members', email: '', createdAt: 0, updatedAt: 0 }) }
    const contributions = new MemberContributions(accounts, memoryContributions(), new FileContributionArtifacts(join(f.root, 'contributions'), []), fakeContributionLibrary(), { now: () => 1 })
    await expect(contributions.submit(member, { purpose: 'Share templates' }, (async function* () { yield upload })(), signal)).rejects.toMatchObject({ code: 'skill-archive-invalid' })
  } finally { await f.close() }
}, 90000)

it('bounds all expanded Git content at 128 MiB, including files outside discovered skills, without changing ordinary size errors', async () => {
  const f = await gitFixture(), signal = new AbortController().signal
  try {
    const commit = await f.commit({ 'skills/one/SKILL.md': validSkill, 'outside.txt': 'x'.repeat(128 * 1024 * 1024 - Buffer.byteLength(validSkill)) })
    const adapter = new GitSkillRepository(join(f.root, 'imports'), f), source = { url: f.url, ref: commit, subpath: '' }
    const imported = await adapter.read(source, signal, 'catalog')
    expect(imported.files.reduce((size, file) => size + file.bytes.length, 0)).toBe(128 * 1024 * 1024)
    await expect(adapter.read(source, signal)).rejects.toMatchObject({ code: 'skill-upload-too-large', params: { reason: 'The repository must be at most 100 MB.' } })
    const over = await f.commit({ 'extra.txt': 'x' })
    await expect(adapter.read({ ...source, ref: over }, signal, 'catalog')).rejects.toMatchObject({ code: 'skill-catalog-limit-exceeded' })
  } finally { await f.close() }
}, 30000)

it('bounds each catalog skill at 64 MiB and retains link safety', async () => {
  const files = [{ path: 'SKILL.md', bytes: Buffer.from(validSkill) }, { path: 'templates/large.txt', bytes: Buffer.alloc(64 * 1024 * 1024 - Buffer.byteLength(validSkill), 'x') }]
  expect(discoverSkillFiles(files, [], false, [], 'catalog').candidates[0]?.files).toHaveLength(2)
  files.push({ path: 'extra.txt', bytes: Buffer.from('x') })
  expect(() => discoverSkillFiles(files, [], false, [], 'catalog')).toThrow(expect.objectContaining({ code: 'skill-catalog-limit-exceeded' }))
  const f = await gitFixture()
  try {
    await f.commit({ 'SKILL.md': validSkill })
    await symlink('/must-not-read', join(f.repo, 'linked.txt'))
    const commit = await f.commit({})
    const artifacts = new FileSkillArtifacts(join(f.root, 'artifacts'), [], new GitSkillRepository(join(f.root, 'imports'), f))
    await expect(artifacts.acceptGit({ url: f.url, ref: commit, subpath: '' }, new AbortController().signal, 'catalog')).rejects.toMatchObject({ code: 'skill-archive-invalid', params: { reason: 'Links and special files are not allowed in imported repositories.' } })
  } finally { await f.close() }
}, 30000)
