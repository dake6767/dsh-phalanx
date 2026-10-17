import { expect, it } from 'vitest'
import { SuiteCatalog } from '../src/use-cases/suite-catalog.js'
import type { SuiteCatalogEntry, SuiteCatalogSuiteEntry } from '../src/domain/suite-catalog.js'
import { suiteInstallOrigin, type SuiteInstallState } from '../src/domain/suite-install.js'
import { actor, delegatedPreset, fixture, suitePreset, text } from './fixtures/suite-catalog.js'

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

it('installs delegated execution disabled when credentials are skipped and enables it once they are saved', async () => {
  const f = fixture(delegatedPreset())
  expect(f.suites.catalog(actor).entries[0]).toMatchObject({ execution: { commands: [{ command: 'suite-cli', blocked: ['auth', 'config'] }], variables: [{ name: 'SUITE_KEY' }] } })
  expect(f.suites.installPreview(actor, 'fixture-suite').creates).toContainEqual({ kind: 'execution', name: 'suite-cli', detail: 'SUITE_KEY' })
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('installed')
  expect(f.record()?.entries).toContainEqual({ kind: 'execution', name: 'one' })
  expect(f.libraryRows.get('one')?.runtimeDependencies).toBeUndefined()
  expect(f.executionRows.get('skill:one')).toMatchObject({ enabled: false, suiteOrigin: 'suite:fixture-suite', runtimeDependencies: ['suite-cli'],
    commands: [{ command: 'suite-cli', blocked: ['auth', 'config'] }], variables: [{ name: 'SUITE_KEY', secret: true, value: '' }] })
  expect(f.suites.catalog(actor).installations[0]).toMatchObject({ missingCredentials: ['SUITE_KEY'] })
  await expect(f.execution.save(actor, 'skill:one', { enabled: true, commands: [{ command: 'suite-cli', blocked: [] }], variables: [{ name: 'SUITE_KEY', secret: true, value: 'x' }] })).rejects.toMatchObject({ code: 'suite-entry-locked' })
  await expect(f.suites.saveCredentials(actor, 'fixture-suite', { OTHER: 'x' })).rejects.toMatchObject({ code: 'suite-catalog-invalid' })
  await f.suites.saveCredentials(actor, 'fixture-suite', { SUITE_KEY: 'team-secret-value' })
  expect(f.executionRows.get('skill:one')).toMatchObject({ enabled: true, variables: [{ name: 'SUITE_KEY', secret: true, value: 'team-secret-value' }] })
  const view = f.suites.catalog(actor)
  expect(view.installations[0]?.missingCredentials).toBeUndefined()
  expect(JSON.stringify(view)).not.toContain('team-secret-value')
  expect(JSON.stringify(f.state)).not.toContain('team-secret-value')
  expect(JSON.stringify(await f.execution.view(actor, 'skill:one'))).not.toContain('team-secret-value')
  // Blank values keep the saved credential.
  await f.suites.saveCredentials(actor, 'fixture-suite', { SUITE_KEY: '  ' })
  expect(f.executionRows.get('skill:one')?.variables[0]?.value).toBe('team-secret-value')
})

it('enables delegated execution at install when the wizard supplies every credential, and removes it on uninstall', async () => {
  const f = fixture(delegatedPreset())
  expect(() => f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa0', credentials: { OTHER: 'x' } })).toThrow(expect.objectContaining({ code: 'suite-catalog-invalid' }))
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'team-secret-value' } })
  await f.settled('installed')
  expect(f.executionRows.get('skill:one')).toMatchObject({ enabled: true, variables: [{ name: 'SUITE_KEY', value: 'team-secret-value' }] })
  expect(JSON.stringify(f.state)).not.toContain('team-secret-value')
  expect(f.suites.uninstallPreview(actor, 'fixture-suite')).toMatchObject({ blocked: [], removes: expect.arrayContaining([{ kind: 'execution', name: 'one' }]) })
  f.suites.uninstall(actor, 'fixture-suite')
  await expect.poll(() => f.state.installs.length).toBe(0)
  expect(f.executionRows.size).toBe(0); expect(f.dependencyRows.size).toBe(0); expect(f.libraryRows.size).toBe(0)
})

it('rolls back delegated execution when a later step fails', async () => {
  const preset = delegatedPreset()
  // A pack listing an unknown skill fails after the execution configuration was written.
  const broken: SuiteCatalogEntry = { ...preset, items: preset.items.map(item => item.kind === 'skill-pack' ? { ...item, skills: ['one', 'ghost'] } : item) }
  const f = fixture(broken)
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'team-secret-value' } })
  await f.settled('failed')
  expect(f.executionRows.size).toBe(0); expect(f.dependencyRows.size).toBe(0); expect(f.libraryRows.size).toBe(0); expect(f.packRows.size).toBe(0)
  expect(JSON.stringify(f.state)).not.toContain('team-secret-value')
})

it('previews and refuses a delegated command that a manual skill already owns', async () => {
  const f = fixture(delegatedPreset())
  f.libraryRows.set('manual', { name: 'manual', description: 'manual', hash: 'manual', importedAt: 0, published: false })
  f.executionRows.set('skill:manual', { enabled: true, commands: [{ command: 'suite-cli', blocked: [] }], variables: [] })
  expect(f.suites.installPreview(actor, 'fixture-suite')).toMatchObject({ reason: 'command-conflicts', commandConflicts: ['suite-cli'], creates: [] })
  expect(() => f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).toThrow(expect.objectContaining({ code: 'execution-config-invalid' }))
  expect(f.state.installs).toHaveLength(0); expect(f.dependencyRows.size).toBe(0)
  // A disabled manual configuration does not hold the command.
  f.executionRows.set('skill:manual', { enabled: false, commands: [{ command: 'suite-cli', blocked: [] }], variables: [] })
  expect(f.suites.installPreview(actor, 'fixture-suite').reason).toBeUndefined()
})

it('detaches a pack so it can be edited, keeps its grants and publication, and keeps it on uninstall', async () => {
  const f = fixture()
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', groups: ['team'], publish: true })
  await f.settled('installed')
  await expect(f.suites.detach(actor, 'fixture-suite', { kind: 'skill-pack', name: 'other' })).rejects.toMatchObject({ code: 'suite-entry-missing' })
  await f.suites.detach(actor, 'fixture-suite', { kind: 'skill-pack', name: 'fixture-suite' })
  expect(f.record()?.entries.map(entry => entry.name)).toEqual(['suite-cli', 'one', 'two'])
  expect(f.packRows.get('fixture-suite')).toMatchObject({ published: true })
  expect(f.packRows.get('fixture-suite')?.suiteOrigin).toBeUndefined()
  expect(f.packGrants.get('team')).toEqual(['fixture-suite'])
  await f.packs.save(actor, { name: 'fixture-suite', description: 'Edited pack', skills: ['one', 'two'], instructions: 'Edited note.', published: true }, f.packs.revision(actor))
  expect(f.packRows.get('fixture-suite')).toMatchObject({ description: 'Edited pack', instructions: 'Edited note.' })
  // The detached pack still lists suite skills; it blocks uninstall until it no longer does, like any manual pack.
  expect(f.suites.uninstallPreview(actor, 'fixture-suite').blocked).toEqual([{ name: 'one', references: [{ kind: 'skill-pack', name: 'fixture-suite' }] }, { name: 'two', references: [{ kind: 'skill-pack', name: 'fixture-suite' }] }])
  await f.suites.detach(actor, 'fixture-suite', { kind: 'skill', name: 'one' })
  await f.suites.detach(actor, 'fixture-suite', { kind: 'skill', name: 'two' })
  // Detached skills still need the suite CLI, so the dependency blocks uninstall until it is detached too.
  expect(f.suites.uninstallPreview(actor, 'fixture-suite').blocked).toEqual([{ name: 'suite-cli', references: [{ kind: 'skill', name: 'one' }, { kind: 'skill', name: 'two' }] }])
  expect(() => f.suites.uninstall(actor, 'fixture-suite')).toThrow(expect.objectContaining({ code: 'runtime-dependency-referenced' }))
  await f.suites.detach(actor, 'fixture-suite', { kind: 'runtime-dependency', name: 'suite-cli' })
  expect(f.dependencyRows.get('suite-cli')).toMatchObject({ source: 'manual', stage: 'ready' })
  expect(f.dependencyRows.get('suite-cli')?.managedOrigin).toBeUndefined()
  f.suites.uninstall(actor, 'fixture-suite')
  await expect.poll(() => f.record()).toBeUndefined()
  expect([...f.libraryRows.keys()].sort()).toEqual(['one', 'two'])
  expect(f.packRows.has('fixture-suite')).toBe(true); expect(f.dependencyRows.has('suite-cli')).toBe(true)
  expect(f.packGrants.get('team')).toEqual(['fixture-suite'])
  expect(f.libraryRows.get('one')).toMatchObject({ runtimeDependencies: ['suite-cli'] })
  expect(f.libraryRows.get('one')?.suiteOrigin).toBeUndefined()
})

it('detaches delegated execution so the execution page can edit it and keeps its credentials', async () => {
  const f = fixture(delegatedPreset())
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'team-secret-value' } })
  await f.settled('installed')
  await f.suites.detach(actor, 'fixture-suite', { kind: 'execution', name: 'one' })
  expect(f.executionRows.get('skill:one')).toMatchObject({ enabled: true, variables: [{ name: 'SUITE_KEY', value: 'team-secret-value' }] })
  expect(f.executionRows.get('skill:one')?.suiteOrigin).toBeUndefined()
  // The suite skill itself is still suite-owned, but its delegated execution is now edited like any manual configuration.
  await f.execution.save(actor, 'skill:one', { enabled: true, commands: [{ command: 'suite-cli', blocked: ['auth'] }], variables: [{ name: 'SUITE_KEY', secret: true }], runtimeDependencies: ['suite-cli'] })
  expect(f.executionRows.get('skill:one')).toMatchObject({ commands: [{ command: 'suite-cli', blocked: ['auth'] }], variables: [{ value: 'team-secret-value' }] })
  expect(f.suites.catalog(actor).installations[0]?.missingCredentials).toBeUndefined()
  await expect(f.suites.saveCredentials(actor, 'fixture-suite', { SUITE_KEY: 'x' })).rejects.toMatchObject({ code: 'suite-catalog-invalid' })
})

it('detaches a skill together with its delegated execution, keeping grants, publication and credentials across uninstall', async () => {
  const f = fixture(delegatedPreset())
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'team-secret-value' } })
  await f.settled('installed')
  await f.library.publish(actor, 'one', true, (await f.library.detail(actor, 'one')).revision).catch(() => {})
  await f.suites.detach(actor, 'fixture-suite', { kind: 'skill', name: 'one' })
  expect(f.record()?.entries.map(entry => `${entry.kind}:${entry.name}`)).toEqual(['runtime-dependency:suite-cli', 'skill-pack:fixture-suite'])
  expect(f.libraryRows.get('one')?.suiteOrigin).toBeUndefined()
  expect(f.executionRows.get('skill:one')?.suiteOrigin).toBeUndefined()
  // Once detached the skill is an ordinary entry: it can be published directly.
  await f.library.publish(actor, 'one', true, (await f.library.detail(actor, 'one')).revision)
  expect(f.libraryRows.get('one')?.published).toBe(true)
  // A second attempt reports the entry is gone from the suite rather than half-applying.
  await expect(f.suites.detach(actor, 'fixture-suite', { kind: 'skill', name: 'one' })).rejects.toMatchObject({ code: 'suite-entry-missing' })
  await f.suites.detach(actor, 'fixture-suite', { kind: 'skill-pack', name: 'fixture-suite' })
  await f.suites.detach(actor, 'fixture-suite', { kind: 'runtime-dependency', name: 'suite-cli' })
  f.suites.uninstall(actor, 'fixture-suite')
  await expect.poll(() => f.record()).toBeUndefined()
  expect(f.libraryRows.get('one')).toMatchObject({ published: true })
  expect(f.executionRows.get('skill:one')).toMatchObject({ enabled: true, variables: [{ name: 'SUITE_KEY', value: 'team-secret-value' }] })
})

it('refuses to detach while a task runs for the suite or for a suite that shares it', async () => {
  const f = fixture()
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await expect(f.suites.detach(actor, 'fixture-suite', { kind: 'skill', name: 'one' })).rejects.toMatchObject({ code: 'suite-task-running' })
  await f.settled('installed')
  await expect(f.suites.detach(actor, 'fixture-suite', { kind: 'skill' })).rejects.toMatchObject({ code: 'suite-entry-missing' })
  await expect(f.suites.detach(actor, 'fixture-suite', { kind: 'skill', name: 'one', extra: true })).rejects.toMatchObject({ code: 'suite-catalog-invalid' })
})

/** A manual 0.1.15-style setup: CLI dependency, same-repository skill with grants and publication, and delegated execution. */
function manualSetup(f: ReturnType<typeof fixture>, url = 'https://git.example/repository') {
  const version = { id: 'manual-version', identity: 'manual', directory: '/private', mountedPath: '/mounted', commands: ['suite-cli'], commandPaths: {}, pathDirectories: ['bin'], bytes: 1, isolated: true, checks: [], log: '' }
  f.dependencyRows.set('my-cli', { name: 'my-cli', source: 'manual', prepareCommand: 'manual install', pathDirectories: ['bin'], stage: 'ready', updatedAt: 0, log: '', checks: [], current: version })
  f.libraryRows.set('one', { name: 'one', description: 'manual one', hash: 'manual-hash', importedAt: 0, published: true, runtimeDependencies: ['my-cli'],
    source: { url, subpath: 'skills', ref: 'main', path: 'skills/one/SKILL.md', commit: 'c'.repeat(40), contentHash: 'manual-hash' } })
  f.granted.set('team', ['one']); f.choices.set('m', ['one'])
  f.executionRows.set('skill:one', { enabled: true, commands: [{ command: 'suite-cli', blocked: [] }], variables: [{ name: 'SUITE_KEY', secret: true, value: 'saved-secret' }], runtimeDependencies: ['my-cli'] })
}

it('lists manual entries the catalog version replaces and refuses to install without confirmation', async () => {
  const f = fixture(delegatedPreset()); manualSetup(f)
  const preview = f.suites.installPreview(actor, 'fixture-suite')
  expect(preview.reason).toBeUndefined()
  expect(preview.replacements).toEqual([{ kind: 'runtime-dependency', name: 'my-cli' }, { kind: 'skill', name: 'one' }])
  expect(() => f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).toThrow(expect.objectContaining({ code: 'suite-replace-unconfirmed' }))
  expect(f.state.installs).toHaveLength(0)
  expect(f.dependencyRows.get('my-cli')?.source).toBe('manual')
})

it('replaces the manual CLI and skill once, keeping references, grants, publication, selections and credentials', async () => {
  const f = fixture(delegatedPreset()); manualSetup(f)
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', replace: [{ kind: 'runtime-dependency', name: 'my-cli' }, { kind: 'skill', name: 'one' }] })
  await f.settled('installed')
  expect([...f.dependencyRows.keys()]).toEqual(['my-cli'])
  expect(f.dependencyRows.get('my-cli')).toMatchObject({ source: 'suite-catalog', managedOrigin: 'suite:fixture-suite', previous: { id: 'manual-version' }, prepareCommand: 'install-suite-cli' })
  // Like MiniMax, the suite skill reaches its CLI only through delegated execution, so the catalog definition decides its PATH.
  expect(f.libraryRows.get('one')).toMatchObject({ suiteOrigin: 'suite:fixture-suite', hash: 'hash-one', published: true })
  expect(f.libraryRows.get('one')?.runtimeDependencies).toBeUndefined()
  expect(f.granted.get('team')).toEqual(['one']); expect(f.choices.get('m')).toEqual(['one'])
  expect(f.executionRows.get('skill:one')).toMatchObject({ suiteOrigin: 'suite:fixture-suite', enabled: true, runtimeDependencies: ['my-cli'], commands: [{ command: 'suite-cli', blocked: ['auth', 'config'] }], variables: [{ name: 'SUITE_KEY', value: 'saved-secret' }] })
  expect(f.record()).toMatchObject({ replaced: [{ kind: 'runtime-dependency', name: 'my-cli' }, { kind: 'skill', name: 'one' }] })
  expect(f.record()?.replacing).toBeUndefined()
  expect(JSON.stringify(f.state)).not.toContain('saved-secret')
})

it('restores every replaced manual entry when the install fails after the takeover', async () => {
  const f = fixture(delegatedPreset()); manualSetup(f); f.failPack()
  const before = { dependency: structuredClone(f.dependencyRows.get('my-cli')), skill: structuredClone(f.libraryRows.get('one')), execution: structuredClone(f.executionRows.get('skill:one')) }
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', replace: [{ kind: 'runtime-dependency', name: 'my-cli' }, { kind: 'skill', name: 'one' }] })
  await f.settled('failed')
  expect(f.dependencyRows.get('my-cli')).toEqual(before.dependency)
  expect(f.libraryRows.get('one')).toEqual(before.skill)
  expect(f.executionRows.get('skill:one')).toEqual(before.execution)
  expect(f.granted.get('team')).toEqual(['one']); expect(f.choices.get('m')).toEqual(['one'])
  expect(f.record()?.replacing).toBeUndefined()
})

it('restores replaced manual entries when a restart interrupts the install', async () => {
  const f = fixture(delegatedPreset()); manualSetup(f)
  const before = { dependency: structuredClone(f.dependencyRows.get('my-cli')), skill: structuredClone(f.libraryRows.get('one')), execution: structuredClone(f.executionRows.get('skill:one')) }
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', replace: [{ kind: 'runtime-dependency', name: 'my-cli' }, { kind: 'skill', name: 'one' }] })
  await f.settled('installed')
  // Simulate a crash after every commit but before the record settled: the originals are still on the record.
  const record = f.state.installs[0]!
  f.state = { ...f.state, installs: [{ ...record, status: 'installing', replacing: { dependencies: [before.dependency!], skills: [before.skill!], executions: [{ owner: 'skill:one', enabled: true, commands: [{ command: 'suite-cli', blocked: [] }], runtimeDependencies: ['my-cli'], variables: [{ name: 'SUITE_KEY', secret: true, hadValue: true }] }] } }] }
  await f.suites.recover()
  expect(f.dependencyRows.get('my-cli')).toEqual(before.dependency)
  expect(f.libraryRows.get('one')).toEqual(before.skill)
  expect(f.executionRows.get('skill:one')).toEqual(before.execution)
  expect(f.record()).toMatchObject({ status: 'failed', failureCode: 'interrupted' })
})

it('marks same-name skills from another repository as conflicts instead of replacing them', async () => {
  const f = fixture(delegatedPreset()); manualSetup(f, 'https://git.example/other')
  const preview = f.suites.installPreview(actor, 'fixture-suite')
  expect(preview).toMatchObject({ reason: 'skill-conflicts', conflicts: ['one'], creates: [] })
  expect(() => f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).toThrow(expect.objectContaining({ code: 'suite-skill-conflict' }))
  expect(f.libraryRows.get('one')?.hash).toBe('manual-hash')
})

it('blocks an install whose CLI commands an MCP catalog dependency provides', async () => {
  const f = fixture()
  f.dependencyRows.set('mcp-cli', { name: 'mcp-cli', source: 'mcp-catalog', managedOrigin: 'mcp:x', prepareCommand: 'x', pathDirectories: ['bin'], stage: 'ready', updatedAt: 0, log: '', checks: [],
    current: { id: 'v', identity: 'x', directory: '/p', mountedPath: '/m', commands: ['suite-cli'], commandPaths: {}, pathDirectories: ['bin'], bytes: 1, isolated: true, checks: [], log: '' } })
  expect(f.suites.installPreview(actor, 'fixture-suite')).toMatchObject({ reason: 'dependency-conflicts', dependencyConflicts: ['mcp-cli'] })
  expect(() => f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).toThrow(expect.objectContaining({ code: 'suite-dependency-conflict' }))
  expect(f.dependencyRows.get('mcp-cli')?.source).toBe('mcp-catalog')
})

it('reuses a manual dependency for a shared catalog dependency without pinning it', async () => {
  const shared: SuiteCatalogEntry = { category: 'dependency', id: 'shared-tool', version: '1', title: text, description: text, source: text,
    items: [{ kind: 'runtime-dependency', name: 'shared-tool', prepareCommands: { amd64: 'install-shared' }, pathDirectories: ['bin'], commands: ['shared-tool'] }] }
  const base = suitePreset(['one']) as SuiteCatalogSuiteEntry
  const preset: SuiteCatalogSuiteEntry = { ...base, dependencies: ['shared-tool'], items: base.items.map(item => item.kind === 'skill' ? { ...item, names: ['one'], catalogDependencies: ['shared-tool'] } : item.kind === 'skill-pack' ? { ...item, skills: ['one'] } : item) }
  const f = fixture(preset, [shared])
  f.dependencyRows.set('my-tool', { name: 'my-tool', source: 'manual', prepareCommand: 'manual', pathDirectories: ['bin'], stage: 'ready', updatedAt: 0, log: '', checks: [],
    current: { id: 'mine', identity: 'm', directory: '/p', mountedPath: '/m', commands: ['shared-tool'], commandPaths: {}, pathDirectories: ['bin'], bytes: 1, isolated: true, checks: [], log: '' } })
  expect(f.suites.installPreview(actor, 'fixture-suite').dependencies).toEqual([{ id: 'shared-tool', action: 'manual', name: 'my-tool' }])
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('installed')
  expect(f.libraryRows.get('one')?.runtimeDependencies).toEqual(['suite-cli', 'my-tool'])
  expect(f.dependencyRows.get('my-tool')).toMatchObject({ source: 'manual', current: { id: 'mine' } })
  expect(f.state.installs.find(row => row.id === 'shared-tool')).toBeUndefined()
  expect(f.suites.catalog(actor).installations.find(row => row.id === 'fixture-suite')).toMatchObject({ manualDependencies: [{ id: 'shared-tool', name: 'my-tool' }] })

  // Switching to the catalog version is a confirmed replace task; the name, and so every reference, carries over.
  expect(f.suites.installPreview(actor, 'shared-tool').replacements).toEqual([{ kind: 'runtime-dependency', name: 'my-tool' }])
  expect(() => f.suites.install(actor, { id: 'shared-tool', requestId: 'request-aaaaaaaaaaaa2' })).toThrow(expect.objectContaining({ code: 'suite-replace-unconfirmed' }))
  f.suites.install(actor, { id: 'shared-tool', requestId: 'request-aaaaaaaaaaaa3', replace: [{ kind: 'runtime-dependency', name: 'my-tool' }] })
  await expect.poll(() => f.state.installs.find(row => row.id === 'shared-tool')?.status).toBe('installed')
  expect(f.dependencyRows.get('my-tool')).toMatchObject({ source: 'suite-catalog', managedOrigin: 'suite:shared-tool', current: { id: 'version-shared-tool' }, previous: { id: 'mine' } })
  expect(f.libraryRows.get('one')?.runtimeDependencies).toEqual(['suite-cli', 'my-tool'])
  expect(f.record()?.manualDependencies).toBeUndefined()
  expect(f.suites.uninstallPreview(actor, 'fixture-suite').dependencies).toEqual([{ id: 'shared-tool', references: [] }])
  expect(f.suites.uninstallPreview(actor, 'shared-tool').blocked.length).toBeGreaterThan(0)
})

it('refuses a confirmation that no longer matches the plan, and a takeover of rows changed while it prepared', async () => {
  const f = fixture(delegatedPreset()); manualSetup(f)
  // Confirming only part of what the preview lists is not a confirmation.
  expect(() => f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', replace: [{ kind: 'skill', name: 'one' }] })).toThrow(expect.objectContaining({ code: 'suite-replace-unconfirmed' }))
  expect(() => f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa2', replace: true })).toThrow(expect.objectContaining({ code: 'suite-catalog-invalid' }))
  const before = structuredClone(f.dependencyRows.get('my-cli'))
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa3', replace: [{ kind: 'runtime-dependency', name: 'my-cli' }, { kind: 'skill', name: 'one' }] })
  // The administrator edits the manual dependency while the suite prepares: it is not taken over, and not rolled back.
  const edited = { ...before!, prepareCommand: 'edited install', updatedAt: 5 }
  f.dependencyRows.set('my-cli', edited)
  await f.settled('failed')
  expect(f.record()).toMatchObject({ failureCode: 'suite-replace-unconfirmed' })
  expect(f.dependencyRows.get('my-cli')).toEqual(edited)
  expect(f.libraryRows.get('one')).toMatchObject({ hash: 'manual-hash' }); expect(f.libraryRows.get('one')?.suiteOrigin).toBeUndefined()
  expect(f.executionRows.get('skill:one')).toMatchObject({ enabled: true, variables: [{ name: 'SUITE_KEY', value: 'saved-secret' }] })
  expect(f.executionRows.get('skill:one')?.suiteOrigin).toBeUndefined()
})

it('never takes over a manual MCP service dependency and blocks shared dependencies other owners provide', async () => {
  const f = fixture(delegatedPreset())
  f.dependencyRows.set('mcp-own', { name: 'mcp-own', source: 'manual', managedOrigin: 'mcp:service', prepareCommand: 'x', pathDirectories: ['bin'], stage: 'ready', updatedAt: 0, log: '', checks: [],
    current: { id: 'v', identity: 'x', directory: '/p', mountedPath: '/m', commands: ['suite-cli'], commandPaths: {}, pathDirectories: ['bin'], bytes: 1, isolated: true, checks: [], log: '' } })
  expect(f.suites.installPreview(actor, 'fixture-suite')).toMatchObject({ reason: 'dependency-conflicts', dependencyConflicts: ['mcp-own'] })
  expect(f.suites.installPreview(actor, 'fixture-suite').replacements).toBeUndefined()

  const shared: SuiteCatalogEntry = { category: 'dependency', id: 'shared-tool', version: '1', title: text, description: text, source: text,
    items: [{ kind: 'runtime-dependency', name: 'shared-tool', prepareCommands: { amd64: 'install-shared' }, pathDirectories: ['bin'], commands: ['shared-tool', 'shared-probe'] }] }
  const base = suitePreset(['one']) as SuiteCatalogSuiteEntry
  const g = fixture({ ...base, dependencies: ['shared-tool'] }, [shared])
  // A manual row providing only part of the commands is neither reused nor silently installed next to.
  g.dependencyRows.set('partial', { name: 'partial', source: 'manual', prepareCommand: 'x', pathDirectories: ['bin'], stage: 'ready', updatedAt: 0, log: '', checks: [],
    current: { id: 'p', identity: 'x', directory: '/p', mountedPath: '/m', commands: ['shared-probe'], commandPaths: {}, pathDirectories: ['bin'], bytes: 1, isolated: true, checks: [], log: '' } })
  expect(g.suites.installPreview(actor, 'fixture-suite')).toMatchObject({ reason: 'dependency-conflicts', dependencyConflicts: ['partial'] })
  expect(() => g.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).toThrow(expect.objectContaining({ code: 'suite-dependency-conflict' }))
})

it('reports a manual skill pack with the suite pack name before installing', async () => {
  const f = fixture()
  f.packRows.set('fixture-suite', { name: 'fixture-suite', description: 'manual', skills: [], instructions: '', published: false })
  expect(f.suites.installPreview(actor, 'fixture-suite')).toMatchObject({ reason: 'pack-conflicts', packConflicts: ['fixture-suite'], creates: [] })
  expect(() => f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).toThrow(expect.objectContaining({ code: 'skill-pack-invalid' }))
})

it('takes over the manual configuration of another replaced skill delegating the same command and keeps extra variables until success', async () => {
  const preset = delegatedPreset() as SuiteCatalogSuiteEntry
  const twoSkills: SuiteCatalogSuiteEntry = { ...preset, items: preset.items.map(item => item.kind === 'skill' ? { ...item, names: ['one', 'two'] } : item.kind === 'skill-pack' ? { ...item, skills: ['one', 'two'] } : item) }
  const f = fixture(twoSkills); manualSetup(f)
  f.libraryRows.set('two', { ...f.libraryRows.get('one')!, name: 'two', hash: 'manual-two' })
  // The 0.1.15 setup put the CLI on skill two, with an extra variable the suite does not declare.
  f.executionRows.delete('skill:one')
  f.executionRows.set('skill:two', { enabled: true, commands: [{ command: 'suite-cli', blocked: [] }], variables: [{ name: 'SUITE_KEY', secret: true, value: 'saved-secret' }, { name: 'PROXY_TOKEN', secret: true, value: 'proxy' }], runtimeDependencies: ['my-cli'] })
  const before = structuredClone(f.executionRows.get('skill:two'))
  expect(f.suites.installPreview(actor, 'fixture-suite').reason).toBeUndefined()
  const replace = [{ kind: 'runtime-dependency' as const, name: 'my-cli' }, { kind: 'skill' as const, name: 'one' }, { kind: 'skill' as const, name: 'two' }]
  f.failPack()
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', replace })
  await f.settled('failed')
  expect(f.executionRows.get('skill:two')).toEqual(before)
  expect(f.executionRows.has('skill:one')).toBe(false)

  const g = fixture(twoSkills); manualSetup(g)
  g.libraryRows.set('two', { ...g.libraryRows.get('one')!, name: 'two', hash: 'manual-two' })
  g.executionRows.delete('skill:one'); g.executionRows.set('skill:two', structuredClone(before!))
  g.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', replace })
  await g.settled('installed')
  // The suite configuration on skill one carries the saved credential; skill two's manual configuration is gone.
  expect(g.executionRows.get('skill:one')).toMatchObject({ suiteOrigin: 'suite:fixture-suite', enabled: true, variables: [{ name: 'SUITE_KEY', value: 'saved-secret' }] })
  expect(g.executionRows.has('skill:two')).toBe(false)
})

it('keeps the originals and the suite rows when a restore fails, and finishes it on the next recovery', async () => {
  const f = fixture(delegatedPreset()); manualSetup(f); f.failPack()
  const before = { dependency: structuredClone(f.dependencyRows.get('my-cli')), skill: structuredClone(f.libraryRows.get('one')) }
  const restore = f.library.restoreSuiteSkills.bind(f.library)
  let broken = true
  f.library.restoreSuiteSkills = async (...args) => { if (broken) throw new Error('disk full'); return restore(...args) }
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', replace: [{ kind: 'runtime-dependency', name: 'my-cli' }, { kind: 'skill', name: 'one' }] })
  await f.settled('failed')
  expect(f.record()?.replacing?.skills.map(row => row.name)).toEqual(['one'])
  // Nothing is deleted while the originals wait: the suite skill row still stands in for the manual one.
  expect(f.libraryRows.get('one')?.suiteOrigin).toBe('suite:fixture-suite')
  expect(() => f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa2', replace: [{ kind: 'runtime-dependency', name: 'my-cli' }, { kind: 'skill', name: 'one' }] })).toThrow(expect.objectContaining({ code: 'suite-task-running' }))
  expect(() => f.suites.uninstall(actor, 'fixture-suite')).toThrow(expect.objectContaining({ code: 'suite-task-running' }))
  broken = false
  await f.suites.recover()
  expect(f.libraryRows.get('one')).toEqual(before.skill)
  expect(f.dependencyRows.get('my-cli')).toEqual(before.dependency)
  expect(f.record()?.replacing).toBeUndefined()
})

it('treats a recorded manual skill deleted during the task as changed, so a failure cannot bring it back', async () => {
  const f = fixture(delegatedPreset()); manualSetup(f)
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', replace: [{ kind: 'runtime-dependency', name: 'my-cli' }, { kind: 'skill', name: 'one' }] })
  f.libraryRows.delete('one')
  await f.settled('failed')
  expect(f.record()).toMatchObject({ failureCode: 'suite-replace-unconfirmed' })
  expect(f.libraryRows.has('one')).toBe(false)
  expect(f.dependencyRows.get('my-cli')?.source).toBe('manual')
})
