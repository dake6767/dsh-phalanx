import { fixtureGallery } from './suite-gallery.js'
import { BusinessRuleError } from '../../src/domain/business-error.js'
import { expect } from 'vitest'
import { RuntimeDependencies } from '../../src/use-cases/runtime-dependencies.js'
import { SuiteCatalog } from '../../src/use-cases/suite-catalog.js'
import { SkillLibrary } from '../../src/use-cases/skill-library.js'
import { SkillPacks } from '../../src/use-cases/skill-packs.js'
import { SkillMembership } from '../../src/use-cases/skill-membership.js'
import { MemberEffectiveSkills } from '../../src/use-cases/member-effective-skills.js'
import type { SuiteCatalogEntry } from '../../src/domain/suite-catalog.js'
import type { SuiteInstallState } from '../../src/domain/suite-install.js'
import type { SkillImportCandidates } from '../../src/domain/skill-import.js'
import type { SkillPack } from '../../src/domain/skill-pack.js'
import type { LibrarySkill } from '../../src/domain/skill-library.js'
import type { RuntimeDependency, RuntimeDependencyVersion } from '../../src/domain/runtime-dependency.js'
import type { ExecutionConfiguration } from '../../src/domain/platform-execution.js'
import { ExecutionAdministration } from '../../src/use-cases/execution-administration.js'
import { RuntimeDependencyConsumers } from '../../src/use-cases/runtime-dependency-consumers.js'

export const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
export const text = { en: 'suite', 'zh-CN': '套件' }
export const commit = 'a'.repeat(40)

export function suitePreset(names: readonly string[] = ['one', 'two']): SuiteCatalogEntry {
  return { category: 'suite', id: 'fixture-suite', version: '1', title: text, description: text, source: text, identity: text, dependencies: [],
    items: [
      { kind: 'runtime-dependency', name: 'suite-cli', prepareCommands: { amd64: 'install-suite-cli' }, pathDirectories: ['bin'], checkCommand: 'suite-cli --version', commands: ['suite-cli'] },
      { kind: 'skill', source: { type: 'git', url: 'https://git.example/repository', commit, path: 'skills' }, names: [...names], runtimeDependency: 'suite-cli' },
      { kind: 'skill-pack', name: 'fixture-suite', description: 'Fixture suite pack', note: 'The platform provides suite-cli.', skills: [...names] },
    ] }
}

/** Shaped like the MiniMax suite: the CLI reaches members only through delegated execution. */
export function delegatedPreset(): SuiteCatalogEntry {
  const base = suitePreset(['one'])
  return { ...base, items: [base.items[0]!, { kind: 'skill', source: { type: 'git', url: 'https://git.example/repository', commit, path: 'skills' }, names: ['one'] },
    { kind: 'execution', skill: 'one', runtimeDependency: 'suite-cli', delegated: [{ command: 'suite-cli', blocked: ['auth', 'config'] }], variables: [{ name: 'SUITE_KEY', purpose: text }] },
    { kind: 'skill-pack', name: 'fixture-suite', description: 'Fixture suite pack', note: 'The platform provides suite-cli.', skills: ['one'] }] }
}

export function fixture(preset: SuiteCatalogEntry = suitePreset(), extra: readonly SuiteCatalogEntry[] = [], plugin?: { readonly port: import('../../src/use-cases/suite-entry-kinds.js').PluginSuitePort, readonly store: import('../../src/ports/plugin-library.js').PluginLibraryStorePort }) {
  const members = [{ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 },
    { ...actor, username: 'member', spaceId: 'm', admin: false, disabled: false, email: '', createdAt: 0, updatedAt: 0, groupId: 'team' }]
  const groups = [{ id: 'admins', name: 'Administrators', kind: 'admin' as const, isDefault: false, memberCount: 1 },
    { id: 'team', name: 'Team', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }]
  const accounts = { get: (name: string) => members.find(row => row.username === name), list: () => members, listGroups: () => groups }
  const assignments = () => {
    const rows = new Map<string, readonly string[]>()
    return { get: (id: string) => rows.get(id) ?? [], set: (id: string, names: readonly string[]) => { rows.set(id, names) }, retain: (ids: readonly string[], keep: readonly string[]) => { for (const id of ids) rows.set(id, (rows.get(id) ?? []).filter(name => keep.includes(name))) } }
  }
  const libraryRows = new Map<string, LibrarySkill>(), packRows = new Map<string, SkillPack>(), dependencyRows = new Map<string, RuntimeDependency>(), executionRows = new Map<string, ExecutionConfiguration>()
  const granted = assignments(), choices = assignments(), packGrants = assignments(), packSelections = assignments()
  let state: SuiteInstallState = { installs: [] }
  const collections: string[][] = []
  let failRemoved: string | undefined
  let failGit = false, mismatch = false, collected = 0, failPack = false
  const skillStore = { list: () => structuredClone([...libraryRows.values()]), save: (row: LibrarySkill) => { libraryRows.set(row.name, structuredClone(row)) }, remove: (name: string) => { libraryRows.delete(name) } }
  const packState = { store: { list: () => structuredClone([...packRows.values()]), save: (row: SkillPack) => { packRows.set(row.name, structuredClone(row)) }, remove: (name: string) => { packRows.delete(name) } }, grants: packGrants, selections: packSelections }
  const artifacts = {
    accept: async () => { throw new Error('unused') },
    newToken: () => 'token',
    read: async () => ({ markdown: '', files: [] }),
    collect: async (keep: readonly string[]) => { collections.push([...keep]) },
    acceptGit: async (source: { ref: string }) => {
      if (failGit) throw new Error('git clone failed')
      const listed = [...new Set(presets().flatMap(entry => entry.items.flatMap(item => item.kind === 'skill' ? item.names : [])))]
      const available = mismatch ? ['other'] : listed
      // Another pinned commit yields different content, so an update re-imports changed skills.
      const hash = (name: string) => source.ref === commit ? `hash-${name}` : `hash-${name}-${source.ref.slice(0, 4)}`
      const candidates: SkillImportCandidates = { candidates: available.map(name => ({ name, description: `${name} skill`, markdown: `# ${name}`, files: ['SKILL.md'], hash: hash(name), path: `skills/${name}/SKILL.md`, internal: false, orchestration: false, warnings: [], source: { url: 'https://git.example/repository', subpath: 'skills', ref: source.ref, path: `skills/${name}/SKILL.md`, commit: source.ref, contentHash: hash(name) } })), packs: [] }
      return candidates
    },
  }
  const executionStore = { get: (owner: string) => structuredClone(executionRows.get(owner)), save: (owner: string, value: ExecutionConfiguration) => { executionRows.set(owner, structuredClone(value)) },
    list: () => [...executionRows].map(([owner, configuration]) => ({ owner, configuration: structuredClone(configuration) })),
    retain: (owners: readonly string[]) => { for (const owner of [...executionRows.keys()]) if (!owners.includes(owner)) executionRows.delete(owner) } }
  const effective = new MemberEffectiveSkills(accounts, skillStore, granted, choices, packState)
  const membership = new SkillMembership(accounts, skillStore, granted, choices, effective, { synchronize: async () => { if (failRemoved && !libraryRows.has(failRemoved)) { failRemoved = undefined; throw new Error('distribution failed') } } }, undefined, packState)
  const library = new SkillLibrary(accounts, skillStore, artifacts, { now: () => 1 }, membership, undefined, ['bundled-skill'], packState)
  const packs = new SkillPacks(accounts, skillStore, packState, granted, library, { createNote: async (name, description) => ({ name, description, markdown: 'note', files: ['SKILL.md'], hash: `note-${name}` }) }, { now: () => 1 }, ['bundled-skill'], choices)
  const dependencies = new RuntimeDependencies(accounts,
    { list: () => structuredClone([...dependencyRows.values()]), save: (row: RuntimeDependency) => { dependencyRows.set(row.name, structuredClone(row)) }, remove: (name: string) => { dependencyRows.delete(name) } },
    { isolated: true, recover: async () => {}, identity: definition => definition.prepareCommand, collect: async () => { collected++ },
      prepare: async definition => ({ id: `version-${definition.name}`, identity: definition.prepareCommand, directory: '/private', mountedPath: '/mounted', commands: [definition.name], commandPaths: {}, pathDirectories: definition.pathDirectories, bytes: 1, isolated: true, checks: [], log: 'prepared' }) satisfies RuntimeDependencyVersion },
    { now: () => 1 }, new RuntimeDependencyConsumers(skillStore, executionStore, undefined, plugin?.store))
  const execution = new ExecutionAdministration(accounts, { get: id => libraryRows.has(id.replace(/^skill:/u, '')) ? { id, version: 'v1' } : undefined, owns: () => true }, executionStore, async () => {}, undefined, undefined, dependencies)
  let catalog: readonly SuiteCatalogEntry[] = [preset, ...extra]
  const presets = () => catalog
  const build = () => new SuiteCatalog(accounts, fixtureGallery(catalog), { read: () => structuredClone(state), write: next => { state = structuredClone(next) } }, dependencies, { now: () => 1 }, 'amd64', library, packs, execution, plugin?.port)
  let suites = build()
  const realCommit = packs.commitSuitePack.bind(packs)
  packs.commitSuitePack = async (...args) => { if (failPack) throw new Error('pack write failed'); return realCommit(...args) }
  const realUpdate = packs.updateSuitePack.bind(packs)
  packs.updateSuitePack = async (...args) => { if (failPack) throw new BusinessRuleError('invalid', 'pack write failed', 'skill-pack-invalid'); return realUpdate(...args) }
  return { get suites() { return suites },
    /** A platform upgrade: the same stores, a catalog with new entry versions. */
    upgrade(next: readonly SuiteCatalogEntry[]) { catalog = next; suites = build() },
    library, packs, dependencies, execution, libraryRows, packRows, dependencyRows, executionRows, packGrants, packSelections, granted, choices, get state() { return state }, set state(next: SuiteInstallState) { state = structuredClone(next) },
    failDistributionOnRemoval(name: string) { failRemoved = name },
    fail() { failGit = true }, mismatch() { mismatch = true }, failPack() { failPack = true },
    get collected() { return collected },
    /** Skill artifact hashes each library collection kept. */
    collections,
    record: () => state.installs.find(row => row.id === 'fixture-suite'),
    async settled(status: 'installed' | 'failed') { await expect.poll(() => state.installs.find(row => row.id === 'fixture-suite')?.status).toBe(status) } }
}

