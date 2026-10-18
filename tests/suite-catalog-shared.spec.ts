import { fixtureGallery } from './fixtures/suite-gallery.js'
import { expect, it } from 'vitest'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import { RuntimeDependencyConsumers } from '../src/use-cases/runtime-dependency-consumers.js'
import { SuiteCatalog } from '../src/use-cases/suite-catalog.js'
import { SkillLibrary } from '../src/use-cases/skill-library.js'
import { SkillPacks } from '../src/use-cases/skill-packs.js'
import { SkillMembership } from '../src/use-cases/skill-membership.js'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import type { SuiteCatalogEntry, SuiteCatalogSuiteEntry } from '../src/domain/suite-catalog.js'
import type { SuiteInstallState } from '../src/domain/suite-install.js'
import type { SkillImportCandidates } from '../src/domain/skill-import.js'
import type { SkillPack } from '../src/domain/skill-pack.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'
import type { RuntimeDependency, RuntimeDependencyVersion } from '../src/domain/runtime-dependency.js'
import { RuntimeDependencyPreparationFailure } from '../src/domain/runtime-dependency.js'

const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
const text = { en: 'entry', 'zh-CN': '条目' }
const commit = 'a'.repeat(40)

const ffmpeg: SuiteCatalogEntry = { category: 'dependency', id: 'ffmpeg', version: '7', title: text, description: text, source: text,
  items: [{ kind: 'runtime-dependency', name: 'ffmpeg', prepareCommands: { amd64: 'install-ffmpeg' }, pathDirectories: ['bin'], commands: ['ffmpeg'] }] }

/** A video suite whose skills need its own CLI plus the shared catalog ffmpeg. */
function videoSuite(id: string): SuiteCatalogSuiteEntry {
  return { category: 'suite', id, version: '1', title: text, description: text, source: text, identity: text, dependencies: ['ffmpeg'],
    items: [
      { kind: 'runtime-dependency', name: `${id}-cli`, prepareCommands: { amd64: `install-${id}` }, pathDirectories: ['bin'], commands: [`${id}-cli`] },
      { kind: 'skill', source: { type: 'git', url: `https://git.example/${id}`, commit, path: 'skills' }, names: [`${id}-render`], runtimeDependency: `${id}-cli`, catalogDependencies: ['ffmpeg'] },
      { kind: 'skill-pack', name: id, description: `${id} pack`, note: 'The platform provides the CLI and ffmpeg.', skills: [`${id}-render`] },
    ] }
}

/** Declares ffmpeg but its skills never list it: the declaration alone must still count as a use. */
function declaringSuite(): SuiteCatalogSuiteEntry {
  const base = videoSuite('gamma')
  return { ...base, items: base.items.map(item => item.kind === 'skill' ? { ...item, catalogDependencies: [] } : item) }
}

function fixture(options: { readonly externalReferences?: (name: string) => readonly { kind: 'mcp' | 'execution', name: string }[], readonly failPack?: boolean, readonly gate?: Promise<void> } = {}) {
  const members = [{ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }]
  const accounts = { get: (name: string) => members.find(row => row.username === name), list: () => members, listGroups: () => [{ id: 'admins', name: 'Administrators', kind: 'admin' as const, isDefault: false, memberCount: 1 }] }
  const assignments = () => {
    const rows = new Map<string, readonly string[]>()
    return { get: (id: string) => rows.get(id) ?? [], set: (id: string, names: readonly string[]) => { rows.set(id, names) }, retain: (ids: readonly string[], keep: readonly string[]) => { for (const id of ids) rows.set(id, (rows.get(id) ?? []).filter(name => keep.includes(name))) } }
  }
  const libraryRows = new Map<string, LibrarySkill>(), packRows = new Map<string, SkillPack>(), dependencyRows = new Map<string, RuntimeDependency>()
  const granted = assignments(), choices = assignments()
  let state: SuiteInstallState = { installs: [] }
  const prepared: string[] = []
  let failing: string | undefined
  const skillStore = { list: () => structuredClone([...libraryRows.values()]), save: (row: LibrarySkill) => { libraryRows.set(row.name, structuredClone(row)) }, remove: (name: string) => { libraryRows.delete(name) } }
  const packState = { store: { list: () => structuredClone([...packRows.values()]), save: (row: SkillPack) => { packRows.set(row.name, structuredClone(row)) }, remove: (name: string) => { packRows.delete(name) } }, grants: assignments(), selections: assignments() }
  const artifacts = {
    accept: async () => { throw new Error('unused') }, newToken: () => 'token', read: async () => ({ markdown: '', files: [] }), collect: async () => {},
    acceptGit: async (source: { url: string }) => {
      const name = `${source.url.split('/').at(-1)}-render`
      return { candidates: [{ name, description: name, markdown: `# ${name}`, files: ['SKILL.md'], hash: `hash-${name}`, path: `skills/${name}/SKILL.md`, internal: false, orchestration: false, warnings: [], source: { url: source.url, subpath: 'skills', ref: commit, path: `skills/${name}/SKILL.md`, commit, contentHash: `hash-${name}` } }], packs: [] } satisfies SkillImportCandidates
    },
  }
  const effective = new MemberEffectiveSkills(accounts, skillStore, granted, choices, packState)
  const library = new SkillLibrary(accounts, skillStore, artifacts, { now: () => 1 }, new SkillMembership(accounts, skillStore, granted, choices, effective, { synchronize: async () => {} }, undefined, packState), undefined, ['bundled-skill'], packState)
  const packs = new SkillPacks(accounts, skillStore, packState, granted, library, { createNote: async (name, description) => ({ name, description, markdown: 'note', files: ['SKILL.md'], hash: `note-${name}` }) }, { now: () => 1 }, ['bundled-skill'], choices)
  const executions = { list: () => [] }
  const consumers = new RuntimeDependencyConsumers(skillStore, executions)
  const references = { list: (name: string) => [...consumers.list(name), ...options.externalReferences?.(name) ?? []] }
  const dependencies = new RuntimeDependencies(accounts,
    { list: () => structuredClone([...dependencyRows.values()]), save: (row: RuntimeDependency) => { dependencyRows.set(row.name, structuredClone(row)) }, remove: (name: string) => { dependencyRows.delete(name) } },
    { isolated: true, recover: async () => {}, identity: definition => definition.prepareCommand, collect: async () => {},
      prepare: async definition => {
        prepared.push(definition.name)
        if (definition.name === 'beta-cli') await options.gate
        if (definition.name === failing) throw new RuntimeDependencyPreparationFailure('check-failed', 'check exited 1')
        return { id: `version-${definition.name}`, identity: definition.prepareCommand, directory: '/private', mountedPath: '/mounted', commands: [definition.name], commandPaths: {}, pathDirectories: definition.pathDirectories, bytes: 1, isolated: true, checks: [], log: 'prepared' } satisfies RuntimeDependencyVersion
      } },
    { now: () => 1 }, references)
  const packPort = options.failPack ? Object.assign(Object.create(packs) as SkillPacks, { commitSuitePack: async () => { throw new Error('pack write failed') } }) : packs
  const presets = [ffmpeg, videoSuite('alpha'), videoSuite('beta'), declaringSuite()]
  const store = { read: () => structuredClone(state), write: (next: SuiteInstallState) => { state = structuredClone(next) } }
  const suites = new SuiteCatalog(accounts, fixtureGallery(presets), store, dependencies, { now: () => 1 }, 'amd64', library, packPort)
  const record = (id: string) => state.installs.find(row => row.id === id)
  return { suites, dependencies, libraryRows, dependencyRows, prepared, record, fail(name: string | undefined) { failing = name },
    get state() { return state }, set state(next: SuiteInstallState) { state = structuredClone(next) },
    restarted: () => new SuiteCatalog(accounts, fixtureGallery(presets), store, dependencies, { now: () => 1 }, 'amd64', library, packs),
    async installed(id: string, requestId: string) {
      suites.install(actor, { id, requestId })
      await expect.poll(() => record(id)?.status).not.toBe('installing')
    },
    async uninstalled(id: string, input?: unknown) {
      suites.uninstall(actor, id, input)
      await expect.poll(() => record(id)).toBeUndefined()
    } }
}

it('installs a missing shared dependency in the same task and reuses it for the next suite without preparing again', async () => {
  const f = fixture()
  expect(f.suites.installPreview(actor, 'alpha').dependencies).toEqual([{ id: 'ffmpeg', action: 'install' }])
  await f.installed('alpha', 'request-aaaaaaaaaaaa1')
  expect(f.record('alpha')).toMatchObject({ status: 'installed', dependencies: ['ffmpeg'] })
  expect(f.record('ffmpeg')).toMatchObject({ status: 'installed', entries: [{ kind: 'runtime-dependency', name: 'ffmpeg' }] })
  expect(f.dependencyRows.get('ffmpeg')).toMatchObject({ source: 'suite-catalog', managedOrigin: 'suite:ffmpeg' })
  expect(f.libraryRows.get('alpha-render')?.runtimeDependencies).toEqual(['alpha-cli', 'ffmpeg'])

  expect(f.suites.installPreview(actor, 'beta').dependencies).toEqual([{ id: 'ffmpeg', action: 'reuse' }])
  await f.installed('beta', 'request-bbbbbbbbbbbb2')
  expect(f.prepared.filter(name => name === 'ffmpeg')).toHaveLength(1)
  expect([...f.dependencyRows.keys()].filter(name => name === 'ffmpeg')).toHaveLength(1)
  expect(f.libraryRows.get('beta-render')?.runtimeDependencies).toEqual(['beta-cli', 'ffmpeg'])
})

it('keeps ffmpeg while another suite uses it and offers removal once nothing does', async () => {
  const f = fixture()
  await f.installed('alpha', 'request-aaaaaaaaaaaa1')
  await f.installed('beta', 'request-bbbbbbbbbbbb2')
  expect(f.suites.uninstallPreview(actor, 'alpha').dependencies).toEqual([{ id: 'ffmpeg', references: [{ kind: 'skill', name: 'beta-render' }, { kind: 'suite', name: 'beta' }] }])
  expect(() => f.suites.uninstall(actor, 'alpha', { removeDependencies: ['ffmpeg'] })).toThrow(expect.objectContaining({ code: 'runtime-dependency-referenced' }))
  await f.uninstalled('alpha')
  expect(f.dependencyRows.has('ffmpeg')).toBe(true)
  expect(f.record('ffmpeg')?.status).toBe('installed')

  expect(f.suites.uninstallPreview(actor, 'beta').dependencies).toEqual([{ id: 'ffmpeg', references: [] }])
  await f.uninstalled('beta', { removeDependencies: ['ffmpeg'] })
  await expect.poll(() => f.record('ffmpeg')).toBeUndefined()
  expect(f.dependencyRows.size).toBe(0)
})

it('keeps an unreferenced shared dependency when the administrator unchecks removal', async () => {
  const f = fixture()
  await f.installed('alpha', 'request-aaaaaaaaaaaa1')
  await f.uninstalled('alpha')
  expect(f.record('ffmpeg')?.status).toBe('installed')
  expect([...f.dependencyRows.keys()]).toEqual(['ffmpeg'])
  // It is still a standalone catalog dependency the administrator can uninstall later.
  await f.uninstalled('ffmpeg')
  expect(f.dependencyRows.size).toBe(0)
})

it('blocks uninstalling a suite or shared dependency that a manual skill references', async () => {
  const f = fixture()
  await f.installed('alpha', 'request-aaaaaaaaaaaa1')
  f.libraryRows.set('manual', { name: 'manual', description: 'manual', hash: 'manual', importedAt: 0, published: false, runtimeDependencies: ['alpha-cli'] })
  expect(f.suites.uninstallPreview(actor, 'alpha').blocked).toEqual([{ name: 'alpha-cli', references: [{ kind: 'skill', name: 'manual' }] }])
  expect(() => f.suites.uninstall(actor, 'alpha')).toThrow(expect.objectContaining({ code: 'runtime-dependency-referenced' }))
  f.libraryRows.set('manual', { name: 'manual', description: 'manual', hash: 'manual', importedAt: 0, published: false, runtimeDependencies: ['ffmpeg'] })
  expect(f.suites.uninstallPreview(actor, 'alpha').dependencies).toEqual([{ id: 'ffmpeg', references: [{ kind: 'skill', name: 'manual' }] }])
  await f.uninstalled('alpha')
  expect(f.dependencyRows.has('ffmpeg')).toBe(true)
  expect(() => f.suites.uninstall(actor, 'ffmpeg')).toThrow(expect.objectContaining({ code: 'runtime-dependency-referenced' }))
})

it('rolls back a shared dependency installed in the same task when the suite fails, but never one that was reused', async () => {
  const f = fixture()
  f.fail('alpha-cli')
  await f.installed('alpha', 'request-aaaaaaaaaaaa1')
  expect(f.record('alpha')).toMatchObject({ status: 'failed', entries: [] })
  expect(f.record('ffmpeg')).toBeUndefined()
  expect(f.dependencyRows.size).toBe(0); expect(f.libraryRows.size).toBe(0)

  f.fail(undefined)
  await f.installed('beta', 'request-bbbbbbbbbbbb2')
  f.fail('alpha-cli')
  await f.installed('alpha', 'request-cccccccccccc3')
  expect(f.record('alpha')?.status).toBe('failed')
  expect(f.record('ffmpeg')?.status).toBe('installed')
  expect([...f.dependencyRows.keys()].sort()).toEqual(['beta-cli', 'ffmpeg'])
})

it('counts a suite that only declares ffmpeg, and MCP or execution references, as users that keep it', async () => {
  let external: { kind: 'mcp' | 'execution', name: string }[] = []
  const f = fixture({ externalReferences: name => name === 'ffmpeg' ? external : [] })
  await f.installed('alpha', 'request-aaaaaaaaaaaa1')
  await f.installed('gamma', 'request-bbbbbbbbbbbb2')
  expect(f.suites.uninstallPreview(actor, 'alpha').dependencies).toEqual([{ id: 'ffmpeg', references: [{ kind: 'suite', name: 'gamma' }] }])
  expect(() => f.suites.uninstall(actor, 'ffmpeg')).toThrow(expect.objectContaining({ code: 'runtime-dependency-referenced' }))
  await f.uninstalled('gamma')
  external = [{ kind: 'mcp', name: 'video-mcp' }, { kind: 'execution', name: 'skill:manual' }]
  expect(f.suites.uninstallPreview(actor, 'alpha').dependencies).toEqual([{ id: 'ffmpeg', references: external }])
  expect(() => f.suites.uninstall(actor, 'alpha', { removeDependencies: ['ffmpeg'] })).toThrow(expect.objectContaining({ code: 'runtime-dependency-referenced' }))
  expect(() => f.suites.uninstall(actor, 'alpha', { removeDependencies: ['pandoc'] })).toThrow(expect.objectContaining({ code: 'suite-catalog-invalid' }))
})

it('rolls back ffmpeg after it was already written to the library when a later suite step fails', async () => {
  const f = fixture({ failPack: true })
  await f.installed('alpha', 'request-aaaaaaaaaaaa1')
  expect(f.record('alpha')?.status).toBe('failed')
  expect(f.record('ffmpeg')).toBeUndefined()
  expect(f.dependencyRows.size).toBe(0); expect(f.libraryRows.size).toBe(0)
})

it('recovers an interrupted install suite-first so the shared dependency rows are removed too', async () => {
  const f = fixture()
  await f.installed('alpha', 'request-aaaaaaaaaaaa1')
  // Simulate a restart in the middle of the task: both records still say installing.
  f.state = { ...f.state, installs: f.state.installs.map(row => ({ ...row, status: 'installing' as const })) }
  await f.restarted().recover()
  expect(f.dependencyRows.size).toBe(0); expect(f.libraryRows.size).toBe(0)
  expect(f.record('alpha')).toMatchObject({ status: 'failed', failureCode: 'interrupted' })
})

it('does not remove a shared dependency that a concurrent install is about to reuse', async () => {
  let release!: () => void
  const f = fixture({ gate: new Promise<void>(resolve => { release = resolve }) })
  await f.installed('alpha', 'request-aaaaaaaaaaaa1')
  f.suites.install(actor, { id: 'beta', requestId: 'request-bbbbbbbbbbbb2' })
  expect(f.suites.uninstallPreview(actor, 'alpha').dependencies).toEqual([{ id: 'ffmpeg', references: [{ kind: 'suite', name: 'beta' }] }])
  expect(() => f.suites.uninstall(actor, 'alpha', { removeDependencies: ['ffmpeg'] })).toThrow(expect.objectContaining({ code: 'runtime-dependency-referenced' }))
  await f.uninstalled('alpha')
  release()
  await expect.poll(() => f.record('beta')?.status).toBe('installed')
  expect(f.dependencyRows.has('ffmpeg')).toBe(true)
  expect(f.libraryRows.get('beta-render')?.runtimeDependencies).toEqual(['beta-cli', 'ffmpeg'])
})
