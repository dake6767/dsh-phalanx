import { expect, it } from 'vitest'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import { SuiteCatalog } from '../src/use-cases/suite-catalog.js'
import { SkillLibrary } from '../src/use-cases/skill-library.js'
import { SkillPacks } from '../src/use-cases/skill-packs.js'
import { SkillMembership } from '../src/use-cases/skill-membership.js'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import type { SuiteCatalogEntry } from '../src/domain/suite-catalog.js'
import type { SuiteInstallState } from '../src/domain/suite-install.js'
import { suiteInstallOrigin } from '../src/domain/suite-install.js'
import type { SkillImportCandidates } from '../src/domain/skill-import.js'
import type { SkillPack } from '../src/domain/skill-pack.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'
import type { RuntimeDependency, RuntimeDependencyVersion } from '../src/domain/runtime-dependency.js'

const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
const text = { en: 'suite', 'zh-CN': '套件' }
const commit = 'a'.repeat(40)

function suitePreset(names: readonly string[] = ['one', 'two']): SuiteCatalogEntry {
  return { category: 'suite', id: 'fixture-suite', version: '1', title: text, description: text, source: text, identity: text, dependencies: [],
    items: [
      { kind: 'runtime-dependency', name: 'suite-cli', prepareCommands: { amd64: 'install-suite-cli' }, pathDirectories: ['bin'], checkCommand: 'suite-cli --version', commands: ['suite-cli'] },
      { kind: 'skill', source: { type: 'git', url: 'https://git.example/repository', commit, path: 'skills' }, names: [...names], runtimeDependency: 'suite-cli' },
      { kind: 'skill-pack', name: 'fixture-suite', description: 'Fixture suite pack', note: 'The platform provides suite-cli.', skills: [...names] },
    ] }
}

function fixture(preset: SuiteCatalogEntry = suitePreset()) {
  const members = [{ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 },
    { ...actor, username: 'member', spaceId: 'm', admin: false, disabled: false, email: '', createdAt: 0, updatedAt: 0, groupId: 'team' }]
  const groups = [{ id: 'admins', name: 'Administrators', kind: 'admin' as const, isDefault: false, memberCount: 1 },
    { id: 'team', name: 'Team', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }]
  const accounts = { get: (name: string) => members.find(row => row.username === name), list: () => members, listGroups: () => groups }
  const assignments = () => {
    const rows = new Map<string, readonly string[]>()
    return { get: (id: string) => rows.get(id) ?? [], set: (id: string, names: readonly string[]) => { rows.set(id, names) }, retain: (ids: readonly string[], keep: readonly string[]) => { for (const id of ids) rows.set(id, (rows.get(id) ?? []).filter(name => keep.includes(name))) } }
  }
  const libraryRows = new Map<string, LibrarySkill>(), packRows = new Map<string, SkillPack>(), dependencyRows = new Map<string, RuntimeDependency>()
  const granted = assignments(), choices = assignments(), packGrants = assignments(), packSelections = assignments()
  let state: SuiteInstallState = { installs: [] }
  let failGit = false, mismatch = false, collected = 0
  const skillStore = { list: () => structuredClone([...libraryRows.values()]), save: (row: LibrarySkill) => { libraryRows.set(row.name, structuredClone(row)) }, remove: (name: string) => { libraryRows.delete(name) } }
  const packState = { store: { list: () => structuredClone([...packRows.values()]), save: (row: SkillPack) => { packRows.set(row.name, structuredClone(row)) }, remove: (name: string) => { packRows.delete(name) } }, grants: packGrants, selections: packSelections }
  const artifacts = {
    accept: async () => { throw new Error('unused') },
    newToken: () => 'token',
    read: async () => ({ markdown: '', files: [] }),
    collect: async () => {},
    acceptGit: async () => {
      if (failGit) throw new Error('git clone failed')
      const available = mismatch ? ['other'] : ['one', 'two']
      const candidates: SkillImportCandidates = { candidates: available.map(name => ({ name, description: `${name} skill`, markdown: `# ${name}`, files: ['SKILL.md'], hash: `hash-${name}`, path: `skills/${name}/SKILL.md`, internal: false, orchestration: false, warnings: [], source: { url: 'https://git.example/repository', subpath: 'skills', ref: commit, path: `skills/${name}/SKILL.md`, commit, contentHash: `hash-${name}` } })), packs: [] }
      return candidates
    },
  }
  const effective = new MemberEffectiveSkills(accounts, skillStore, granted, choices, packState)
  const membership = new SkillMembership(accounts, skillStore, granted, choices, effective, { synchronize: async () => {} }, undefined, packState)
  const library = new SkillLibrary(accounts, skillStore, artifacts, { now: () => 1 }, membership, undefined, ['bundled-skill'], packState)
  const packs = new SkillPacks(accounts, skillStore, packState, granted, library, { createNote: async (name, description) => ({ name, description, markdown: 'note', files: ['SKILL.md'], hash: `note-${name}` }) }, { now: () => 1 }, ['bundled-skill'], choices)
  const dependencies = new RuntimeDependencies(accounts,
    { list: () => structuredClone([...dependencyRows.values()]), save: (row: RuntimeDependency) => { dependencyRows.set(row.name, structuredClone(row)) }, remove: (name: string) => { dependencyRows.delete(name) } },
    { isolated: true, recover: async () => {}, identity: definition => definition.prepareCommand, collect: async () => { collected++ },
      prepare: async definition => ({ id: `version-${definition.name}`, identity: definition.prepareCommand, directory: '/private', mountedPath: '/mounted', commands: [definition.name], commandPaths: {}, pathDirectories: definition.pathDirectories, bytes: 1, isolated: true, checks: [], log: 'prepared' }) satisfies RuntimeDependencyVersion },
    { now: () => 1 }, { list: () => [] })
  const suites = new SuiteCatalog(accounts, [preset], { read: () => structuredClone(state), write: next => { state = structuredClone(next) } }, dependencies, { now: () => 1 }, 'amd64', library, packs)
  return { suites, library, packs, dependencies, libraryRows, packRows, dependencyRows, packGrants, packSelections, get state() { return state },
    fail() { failGit = true }, mismatch() { mismatch = true },
    get collected() { return collected },
    record: () => state.installs.find(row => row.id === 'fixture-suite'),
    async settled(status: 'installed' | 'failed') { await expect.poll(() => state.installs.find(row => row.id === 'fixture-suite')?.status).toBe(status) } }
}

it('installs a suite with skills, a pack and the CLI dependency, and honors wizard grants and publication', async () => {
  const f = fixture()
  const preview = f.suites.installPreview(actor, 'fixture-suite')
  expect(preview.creates).toEqual([
    { kind: 'runtime-dependency', name: 'suite-cli', commands: ['suite-cli'] },
    { kind: 'skill', name: '2 skills', detail: 'https://git.example/repository @ aaaaaaa' },
    { kind: 'skill-pack', name: 'fixture-suite', detail: '2 skills' },
  ])
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', groups: ['team'], publish: true })
  await f.settled('installed')
  expect(f.record()).toMatchObject({ status: 'installed', entries: [
    { kind: 'runtime-dependency', name: 'suite-cli' }, { kind: 'skill', name: 'one' }, { kind: 'skill', name: 'two' }, { kind: 'skill-pack', name: 'fixture-suite' }] })
  expect(f.dependencyRows.get('suite-cli')).toMatchObject({ source: 'suite-catalog', managedOrigin: suiteInstallOrigin('fixture-suite'), stage: 'ready' })
  for (const name of ['one', 'two']) expect(f.libraryRows.get(name)).toMatchObject({ suiteOrigin: suiteInstallOrigin('fixture-suite'), runtimeDependencies: ['suite-cli'], published: false })
  expect(f.packRows.get('fixture-suite')).toMatchObject({ suiteOrigin: suiteInstallOrigin('fixture-suite'), published: true, skills: ['one', 'two'], note: { name: 'fixture-suite' } })
  expect(f.packGrants.get('team')).toEqual(['fixture-suite'])
  expect(f.suites.catalog(actor).entries.find(entry => entry.id === 'fixture-suite')).toMatchObject({ category: 'suite', packName: 'fixture-suite', skills: ['one', 'two'] })
})

it('rolls back the CLI dependency when the Git import fails, and reports mismatches and conflicts', async () => {
  const f = fixture(); f.fail()
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('failed')
  expect(f.dependencyRows.size).toBe(0); expect(f.libraryRows.size).toBe(0); expect(f.packRows.size).toBe(0)
  expect(f.record()?.log).toContain('git clone failed')

  const mismatched = fixture(); mismatched.mismatch()
  mismatched.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await mismatched.settled('failed')
  expect(mismatched.record()).toMatchObject({ failureCode: 'suite-skill-mismatch' })
  expect(mismatched.dependencyRows.size).toBe(0)

  const conflicted = fixture()
  conflicted.libraryRows.set('one', { name: 'one', description: 'manual', hash: 'manual', importedAt: 0, published: false })
  expect(() => conflicted.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).toThrow(expect.objectContaining({ code: 'suite-skill-conflict' }))
  expect(conflicted.libraryRows.get('one')).toMatchObject({ hash: 'manual' })
  expect(conflicted.dependencyRows.size).toBe(0)
})

it('keeps suite-owned skills and packs read-only', async () => {
  const f = fixture()
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('installed')
  const detail = await f.library.detail(actor, 'one')
  await expect(f.library.publish(actor, 'one', true, detail.revision)).rejects.toMatchObject({ code: 'suite-entry-locked' })
  await expect(f.library.remove(actor, 'one', detail.revision)).rejects.toMatchObject({ code: 'suite-entry-locked' })
  await expect(f.library.setRuntimeDependencies(actor, 'one', [], detail.revision)).rejects.toMatchObject({ code: 'suite-entry-locked' })
  const packRevision = f.packs.revision(actor)
  await expect(f.packs.save(actor, { name: 'fixture-suite', description: 'Changed', skills: ['one'], instructions: '', published: false }, packRevision)).rejects.toMatchObject({ code: 'suite-entry-locked' })
  await expect(f.packs.remove(actor, 'fixture-suite', false, f.packs.detail(actor, 'fixture-suite').revision)).rejects.toMatchObject({ code: 'suite-entry-locked' })
})

it('previews and completes uninstalls, revoking grants and selections, and blocks manual pack references', async () => {
  const f = fixture()
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', groups: ['team'], publish: true })
  await f.settled('installed')
  f.packSelections.set('m', ['fixture-suite'])
  const preview = f.suites.uninstallPreview(actor, 'fixture-suite')
  expect(preview.removes.map(entry => entry.name)).toEqual(['suite-cli', 'one', 'two', 'fixture-suite'])
  expect(preview.impact).toEqual([{ name: 'fixture-suite', groups: [{ id: 'admins', name: 'Administrators' }, { id: 'team', name: 'Team' }], published: true, selectedMembers: 1 }])
  f.suites.uninstall(actor, 'fixture-suite')
  await expect.poll(() => f.state.installs.length).toBe(0)
  expect(f.dependencyRows.size).toBe(0); expect(f.libraryRows.size).toBe(0); expect(f.packRows.size).toBe(0)
  expect(f.packGrants.get('team')).toEqual([]); expect(f.packSelections.get('m')).toEqual([])

  const blocked = fixture()
  blocked.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await blocked.settled('installed')
  blocked.packRows.set('manual', { name: 'manual', description: 'Manual pack', skills: ['one'], instructions: '', published: false })
  expect(blocked.suites.uninstallPreview(actor, 'fixture-suite').blocked).toEqual([{ name: 'one', references: [{ kind: 'skill-pack', name: 'manual' }] }])
  expect(() => blocked.suites.uninstall(actor, 'fixture-suite')).toThrow(expect.objectContaining({ code: 'runtime-dependency-referenced' }))
  expect(blocked.record()?.status).toBe('installed')
})

it('lists skill conflicts in the preview and blocks zip/git imports from replacing suite skills', async () => {
  const f = fixture()
  f.libraryRows.set('one', { name: 'one', description: 'manual', hash: 'manual', importedAt: 0, published: false })
  const preview = f.suites.installPreview(actor, 'fixture-suite')
  expect(preview).toMatchObject({ reason: 'skill-conflicts', conflicts: ['one'] })
  expect(preview.creates).toEqual([])
  expect(() => f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).toThrow(expect.objectContaining({ code: 'suite-skill-conflict' }))
  expect(f.state.installs).toHaveLength(0)

  const installed = fixture()
  installed.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await installed.settled('installed')
  const manual = { name: 'one', description: 'replacement', hash: 'replacement', markdown: '# one', files: ['SKILL.md'], path: 'one/SKILL.md', internal: false, orchestration: false, warnings: [] }
  await expect(installed.library.confirmImport(actor, { token: 'token', names: ['one'], replacements: ['one'], packs: [] })).rejects.toMatchObject({ code: 'skill-preview-changed' })
  void manual
})

it('recovers interrupted suite installs by removing every owned row', async () => {
  const f = fixture()
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('installed')
  let state: SuiteInstallState = { installs: [{ ...structuredClone(f.record()!)!, status: 'installing' as const }] }
  const recovering = new SuiteCatalog({ get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }) }, [suitePreset()],
    { read: () => structuredClone(state), write: next => { state = structuredClone(next) } }, f.dependencies, { now: () => 1 }, 'amd64', f.library, f.packs)
  await recovering.recover()
  expect(f.dependencyRows.size).toBe(0); expect(f.libraryRows.size).toBe(0); expect(f.packRows.size).toBe(0)
  expect(state.installs[0]).toMatchObject({ status: 'failed', failureCode: 'interrupted' })
})
