import { expect, it } from 'vitest'
import type { SuiteCatalogEntry, SuiteCatalogSuiteEntry } from '../src/domain/suite-catalog.js'
import { compareSuiteVersions } from '../src/domain/suite-install.js'
import { actor, delegatedPreset, suitePreset, fixture, text } from './fixtures/suite-catalog.js'

const nextCommit = 'b'.repeat(40)
/** Version 2 of the delegated fixture: a new CLI build, skills at a new commit with `two` added, a new blocked argument and variable. */
function version2(base = delegatedPreset() as SuiteCatalogSuiteEntry, change: Partial<{ prepare: string, names: readonly string[] }> = {}): SuiteCatalogSuiteEntry {
  const names = change.names ?? ['one', 'two']
  return { ...base, version: '2', items: base.items.map(item => item.kind === 'runtime-dependency' ? { ...item, prepareCommands: { amd64: change.prepare ?? 'install-suite-cli-2' } }
    : item.kind === 'skill' ? { ...item, source: { ...item.source, commit: nextCommit }, names: [...names] }
    : item.kind === 'skill-pack' ? { ...item, skills: [...names] }
    : item.kind !== 'execution' ? item : { ...item, delegated: [{ command: 'suite-cli', blocked: ['auth', 'config', 'update'] }], variables: [...item.variables, { name: 'SUITE_REGION', purpose: text }] }) }
}
async function installed(preset: SuiteCatalogEntry = delegatedPreset()) {
  const f = fixture(preset)
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', groups: ['team'], publish: true, credentials: preset.items.some(item => item.kind === 'execution') ? { SUITE_KEY: 'team-key' } : {} })
  await f.settled('installed')
  f.packSelections.set('m', ['fixture-suite'])
  return f
}

it('compares dotted catalog versions numerically', () => {
  expect(compareSuiteVersions('10', '9')).toBeGreaterThan(0)
  expect(compareSuiteVersions('1.2', '1.10')).toBeLessThan(0)
  expect(compareSuiteVersions('1', '1.0')).toBe(0)
})

it('offers an update only when the catalog version is newer and the platform upgrade changes nothing by itself', async () => {
  const f = await installed()
  expect(f.suites.catalog(actor).entries[0]?.updateAvailable).toBeUndefined()
  const before = { dependency: structuredClone(f.dependencyRows.get('suite-cli')), skill: structuredClone(f.libraryRows.get('one')) }
  f.upgrade([version2()])
  expect(f.suites.catalog(actor).entries[0]).toMatchObject({ installedVersion: '1', version: '2', updateAvailable: true })
  expect(f.dependencyRows.get('suite-cli')).toEqual(before.dependency)
  expect(f.libraryRows.get('one')).toEqual(before.skill)
  f.upgrade([{ ...version2(), version: '0.9' }])
  expect(f.suites.catalog(actor).entries[0]?.updateAvailable).toBeUndefined()
  expect(f.suites.updatePreview(actor, 'fixture-suite').reason).toBe('up-to-date')
})

it('previews dependency, skill, pack and delegated execution differences', async () => {
  const f = await installed()
  f.upgrade([version2()])
  expect(f.suites.updatePreview(actor, 'fixture-suite')).toEqual({
    id: 'fixture-suite', from: '1', to: '2', dependency: { name: 'suite-cli', changed: true },
    skills: { added: ['two'], removed: [], updated: ['one'] }, pack: { name: 'fixture-suite', added: ['two'], removed: [] },
    execution: { commands: { added: [], removed: [], changed: ['suite-cli'] }, variables: { added: ['SUITE_REGION'], removed: [] } },
    dependents: [], skipped: [], manualDependencies: [] })
})

it('switches every step once prepared, keeping grants, publication, selections and saved credentials; new variables keep execution off', async () => {
  const f = await installed()
  const previous = f.dependencyRows.get('suite-cli')!.current!
  f.upgrade([version2()])
  f.suites.update(actor, 'fixture-suite')
  await expect.poll(() => f.record()?.version).toBe('2')
  expect(f.record()).toMatchObject({ status: 'installed', entries: expect.arrayContaining([{ kind: 'skill', name: 'two' }, { kind: 'skill-pack', name: 'fixture-suite' }, { kind: 'execution', name: 'one' }]) })
  expect(f.record()?.updating).toBeUndefined()
  expect(f.dependencyRows.get('suite-cli')).toMatchObject({ prepareCommand: 'install-suite-cli-2', previous: { id: previous.id } })
  expect(f.libraryRows.get('one')).toMatchObject({ hash: 'hash-one-bbbb', published: false })
  // The new skill joins the suite pack, so the pack grant reaches it.
  expect(f.packRows.get('fixture-suite')).toMatchObject({ skills: ['one', 'two'], published: true })
  expect(f.packGrants.get('team')).toEqual(['fixture-suite'])
  expect(f.packSelections.get('m')).toEqual(['fixture-suite'])
  expect(f.executionRows.get('skill:one')).toMatchObject({ enabled: false, commands: [{ command: 'suite-cli', blocked: ['auth', 'config', 'update'] }], variables: [{ name: 'SUITE_KEY', value: 'team-key' }, { name: 'SUITE_REGION', value: '' }] })
  expect(f.suites.catalog(actor).installations[0]).toMatchObject({ missingCredentials: ['SUITE_REGION'] })
  expect(f.suites.catalog(actor).entries[0]?.updateAvailable).toBeUndefined()
})

it('keeps the old version in use when a step fails and when a restart interrupts the update', async () => {
  const f = await installed()
  const before = { dependency: structuredClone(f.dependencyRows.get('suite-cli')), skill: structuredClone(f.libraryRows.get('one')), pack: structuredClone(f.packRows.get('fixture-suite')), execution: structuredClone(f.executionRows.get('skill:one')) }
  f.upgrade([version2()]); f.failPack()
  f.suites.update(actor, 'fixture-suite')
  await expect.poll(() => f.record()?.status).toBe('installed')
  expect(f.record()).toMatchObject({ version: '1', failureCode: 'skill-pack-invalid' })
  expect(f.dependencyRows.get('suite-cli')).toEqual(before.dependency)
  expect(f.libraryRows.get('one')).toEqual(before.skill)
  expect(f.libraryRows.has('two')).toBe(false)
  expect(f.packRows.get('fixture-suite')).toEqual(before.pack)
  expect(f.executionRows.get('skill:one')).toEqual(before.execution)
  expect(f.suites.catalog(actor).entries[0]?.updateAvailable).toBe(true)

  // A restart while updating: the record still holds the version it found, which is switched back.
  const g = await installed()
  const original = structuredClone(g.libraryRows.get('one'))
  g.upgrade([version2()])
  g.suites.update(actor, 'fixture-suite')
  await expect.poll(() => g.record()?.version).toBe('2')
  g.state = { ...g.state, installs: g.state.installs.map(row => ({ ...row, status: 'updating', version: '1', updating: { version: '1', entries: row.entries.filter(entry => entry.name !== 'two'), dependencyRows: [before.dependency!], skills: [original!], pack: before.pack!, executions: [{ owner: 'skill:one', enabled: true, commands: [{ command: 'suite-cli', blocked: ['auth', 'config'] }], runtimeDependencies: ['suite-cli'], variables: [{ name: 'SUITE_KEY', secret: true, hadValue: true }] }] } })) }
  await g.suites.recover()
  expect(g.record()).toMatchObject({ status: 'installed', version: '1', failureCode: 'interrupted' })
  expect(g.libraryRows.get('one')).toEqual(original)
  expect(g.libraryRows.has('two')).toBe(false)
  expect(g.executionRows.get('skill:one')).toMatchObject({ enabled: true, variables: [{ name: 'SUITE_KEY', value: 'team-key' }] })
})

it('removes skills the new version drops and leaves detached entries alone', async () => {
  const base = delegatedPreset() as SuiteCatalogSuiteEntry
  const two: SuiteCatalogSuiteEntry = { ...base, items: base.items.map(item => item.kind === 'skill' ? { ...item, names: ['one', 'two'] } : item.kind === 'skill-pack' ? { ...item, skills: ['one', 'two'] } : item) }
  const f = await installed(two)
  await f.suites.detach(actor, 'fixture-suite', { kind: 'runtime-dependency', name: 'suite-cli' })
  const detachedTool = structuredClone(f.dependencyRows.get('suite-cli'))
  f.upgrade([version2(two, { names: ['one'] })])
  const preview = f.suites.updatePreview(actor, 'fixture-suite')
  expect(preview).toMatchObject({ skills: { added: [], removed: ['two'], updated: ['one'] }, skipped: [{ kind: 'runtime-dependency', name: 'suite-cli' }] })
  expect(preview.dependency).toBeUndefined()
  f.suites.update(actor, 'fixture-suite')
  await expect.poll(() => f.record()?.version).toBe('2')
  expect(f.libraryRows.has('two')).toBe(false)
  expect(f.packRows.get('fixture-suite')?.skills).toEqual(['one'])
  // The detached CLI is the administrator's now: not re-prepared and not taken back.
  expect(f.dependencyRows.get('suite-cli')).toEqual(detachedTool)
  expect(f.record()?.entries.some(entry => entry.kind === 'runtime-dependency')).toBe(false)
})

it('leaves a manual dependency used in place of a shared catalog dependency untouched and lists the suites using a shared dependency', async () => {
  const shared: SuiteCatalogEntry = { category: 'dependency', id: 'shared-tool', version: '1', title: text, description: text, source: text,
    items: [{ kind: 'runtime-dependency', name: 'shared-tool', prepareCommands: { amd64: 'install-shared' }, pathDirectories: ['bin'], commands: ['shared-tool'] }] }
  const base = delegatedPreset() as SuiteCatalogSuiteEntry
  const suite: SuiteCatalogSuiteEntry = { ...base, dependencies: ['shared-tool'], items: base.items.map(item => item.kind === 'skill' ? { ...item, catalogDependencies: ['shared-tool'] } : item) }
  const f = fixture(suite, [shared])
  f.dependencyRows.set('my-tool', { name: 'my-tool', source: 'manual', prepareCommand: 'manual', pathDirectories: ['bin'], stage: 'ready', updatedAt: 0, log: '', checks: [],
    current: { id: 'mine', identity: 'm', directory: '/p', mountedPath: '/m', commands: ['shared-tool'], commandPaths: {}, pathDirectories: ['bin'], bytes: 1, isolated: true, checks: [], log: '' } })
  f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('installed')
  const manual = structuredClone(f.dependencyRows.get('my-tool'))
  f.upgrade([version2(suite), { ...shared, version: '2' }])
  expect(f.suites.updatePreview(actor, 'fixture-suite').manualDependencies).toEqual([{ id: 'shared-tool', name: 'my-tool' }])
  f.suites.update(actor, 'fixture-suite')
  await expect.poll(() => f.record()?.version).toBe('2')
  expect(f.dependencyRows.get('my-tool')).toEqual(manual)
  expect(f.libraryRows.get('one')?.runtimeDependencies).toEqual(['my-tool'])

  const g = fixture(suite, [shared])
  g.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await g.settled('installed')
  g.upgrade([suite, { ...shared, version: '2', items: [{ ...shared.items[0]!, prepareCommands: { amd64: 'install-shared-2' } } as SuiteCatalogEntry['items'][number]] }])
  expect(g.suites.updatePreview(actor, 'shared-tool')).toMatchObject({ dependents: ['fixture-suite'], dependency: { name: 'shared-tool', changed: true } })
  g.suites.update(actor, 'shared-tool')
  await expect.poll(() => g.state.installs.find(row => row.id === 'shared-tool')?.version).toBe('2')
  expect(g.dependencyRows.get('shared-tool')).toMatchObject({ prepareCommand: 'install-shared-2' })
  expect(g.libraryRows.get('one')?.runtimeDependencies).toEqual(['shared-tool'])
})

it('refuses updates that are not ready and keeps a concurrent task out', async () => {
  const f = await installed()
  expect(() => f.suites.update(actor, 'fixture-suite')).toThrow(expect.objectContaining({ code: 'suite-up-to-date' }))
  f.upgrade([version2()])
  f.suites.update(actor, 'fixture-suite')
  expect(f.suites.updatePreview(actor, 'fixture-suite').reason).toBe('task-running')
  expect(() => f.suites.update(actor, 'fixture-suite')).toThrow(expect.objectContaining({ code: 'suite-task-running' }))
  expect(() => f.suites.uninstall(actor, 'fixture-suite')).toThrow(expect.objectContaining({ code: 'suite-task-running' }))
  await expect.poll(() => f.record()?.status).toBe('installed')
})

it('keeps the artifacts of the installed version while an update may still restore them', async () => {
  const f = await installed()
  f.upgrade([version2()]); f.failPack()
  const from = f.collections.length
  f.suites.update(actor, 'fixture-suite')
  await expect.poll(() => f.record()?.status).toBe('installed')
  // Every collection that ran while the record held the snapshot kept the installed skill content.
  const during = f.collections.slice(from)
  expect(during.length).toBeGreaterThan(0)
  expect(during.every(keep => keep.includes('hash-one'))).toBe(true)
})


it('retains the rollback snapshot and blocks changes until failed recovery can finish', async () => {
  const f = await installed()
  f.upgrade([version2()]); f.failPack()
  const restore = f.library.restoreSuiteUpdate.bind(f.library)
  f.library.restoreSuiteUpdate = async () => { throw new Error('temporary storage failure') }
  f.suites.update(actor, 'fixture-suite')
  await expect.poll(() => f.record()?.log).toContain('Recovery failed')
  expect(f.record()?.status).toBe('updating')
  expect(f.record()?.updating?.version).toBe('1')
  expect(() => f.suites.update(actor, 'fixture-suite')).toThrow(expect.objectContaining({ code: 'suite-task-running' }))
  f.library.restoreSuiteUpdate = restore
  await f.suites.recover()
  expect(f.record()).toMatchObject({ status: 'installed', version: '1' })
  expect(f.record()?.updating).toBeUndefined()
  expect(f.libraryRows.has('two')).toBe(false)
})


it('updates multiple skill sources and excludes detached execution from the preview', async () => {
  const base = suitePreset(['one', 'two']) as SuiteCatalogSuiteEntry
  const grouped: SuiteCatalogSuiteEntry = { ...base, items: base.items.flatMap<SuiteCatalogEntry['items'][number]>(item => item.kind === 'skill' ? [{ ...item, names: ['one'] }, { ...item, source: { ...item.source, path: 'other' }, names: ['two'] }] : [item]) }
  // Install a single group, then let the new catalog split its sources.
  const f = await installed(base)
  f.upgrade([{ ...grouped, version: '2' }])
  f.suites.update(actor, 'fixture-suite')
  await expect.poll(() => f.record()?.version).toBe('2')
  expect(f.libraryRows.get('one')?.runtimeDependencies).toEqual(['suite-cli'])
  expect(f.libraryRows.get('two')?.runtimeDependencies).toEqual(['suite-cli'])

  const g = await installed()
  g.upgrade([{ ...version2(), items: version2().items.filter(item => item.kind !== 'execution') }])
  expect(g.suites.updatePreview(actor, 'fixture-suite').execution).toMatchObject({ commands: { removed: ['suite-cli'] }, variables: { removed: ['SUITE_KEY'] } })
  await g.suites.detach(actor, 'fixture-suite', { kind: 'execution', name: 'one' })
  g.upgrade([version2()])
  expect(g.suites.updatePreview(actor, 'fixture-suite').execution).toBeUndefined()
})

it('clears shared dependency references when the new suite no longer uses them', async () => {
  const shared: SuiteCatalogEntry = { category: 'dependency', id: 'shared-tool', version: '1', title: text, description: text, source: text,
    items: [{ kind: 'runtime-dependency', name: 'shared-tool', prepareCommands: { amd64: 'shared' }, pathDirectories: ['bin'], commands: ['shared-tool'] }] }
  const base = delegatedPreset() as SuiteCatalogSuiteEntry
  const f = fixture({ ...base, dependencies: ['shared-tool'] }, [shared])
  f.suites.install(actor, { id: base.id, requestId: 'request-aaaaaaaaaaaa1' }); await f.settled('installed')
  f.upgrade([version2(), { ...shared, version: '2' }])
  f.suites.update(actor, base.id)
  await expect.poll(() => f.record()?.version).toBe('2')
  expect(f.record()?.dependencies ?? []).toEqual([])
  expect(f.suites.updatePreview(actor, shared.id).dependents).toEqual([])
})


it('restores direct grants and selections when removing a skill fails during distribution', async () => {
  const base = delegatedPreset() as SuiteCatalogSuiteEntry
  const both = { ...base, items: base.items.map(item => item.kind === 'skill' ? { ...item, names: ['one', 'two'] } : item.kind === 'skill-pack' ? { ...item, skills: ['one', 'two'] } : item) }
  const f = await installed(both)
  f.libraryRows.set('two', { ...f.libraryRows.get('two')!, published: true })
  f.granted.set('team', ['two']); f.choices.set('m', ['two'])
  f.upgrade([version2(both, { names: ['one'] })]); f.failDistributionOnRemoval('two')
  f.suites.update(actor, 'fixture-suite')
  await expect.poll(() => f.record()?.failureCode).toBe('skill-sync-failed')
  expect(f.record()).toMatchObject({ status: 'installed', version: '1' })
  expect(f.granted.get('team')).toEqual(['two'])
  expect(f.choices.get('m')).toEqual(['two'])
  expect(f.packRows.get('fixture-suite')?.skills).toEqual(['one', 'two'])
})


it('keeps administrator-disabled delegated execution off when updating its commands', async () => {
  const f = await installed()
  f.executionRows.set('skill:one', { ...f.executionRows.get('skill:one')!, enabled: false })
  const next = version2()
  f.upgrade([{ ...next, items: next.items.map(item => item.kind === 'execution' ? { ...item, variables: item.variables.filter(row => row.name === 'SUITE_KEY') } : item) }])
  f.suites.update(actor, 'fixture-suite')
  await expect.poll(() => f.record()?.version).toBe('2')
  expect(f.executionRows.get('skill:one')?.enabled).toBe(false)
})


it('resumes pending execution cleanup after a failure without losing the committed version', async () => {
  const f = await installed()
  const next = version2()
  f.upgrade([{ ...next, items: next.items.filter(item => item.kind !== 'execution') }])
  const finalize = f.execution.finalizeSuiteExecutions.bind(f.execution)
  f.execution.finalizeSuiteExecutions = async () => { throw new Error('storage unavailable') }
  f.suites.update(actor, 'fixture-suite')
  await expect.poll(() => f.record()?.log).toContain('Cleanup pending')
  expect(f.record()).toMatchObject({ status: 'updating', version: '2', settling: [] })
  f.execution.finalizeSuiteExecutions = finalize
  await f.suites.recover()
  expect(f.record()).toMatchObject({ status: 'installed', version: '2' })
  expect(f.record()?.settling).toBeUndefined()
  expect(f.executionRows.has('skill:one')).toBe(false)
})

it('does not resurrect assignments revoked while preparing an update that fails', async () => {
  const f = await installed()
  f.libraryRows.set('one', { ...f.libraryRows.get('one')!, published: true })
  f.granted.set('team', ['one']); f.choices.set('m', ['one'])
  const prepare = f.library.prepareSuiteImport.bind(f.library)
  f.library.prepareSuiteImport = async (...args) => {
    await prepare(...args)
    f.granted.set('team', []); f.choices.set('m', [])
  }
  f.upgrade([version2()]); f.failPack()
  f.suites.update(actor, 'fixture-suite')
  await expect.poll(() => f.record()?.failureCode).toBe('skill-pack-invalid')
  expect(f.granted.get('team')).toEqual([])
  expect(f.choices.get('m')).toEqual([])
})


it('keeps the adopted library name when a taken-over dependency is later detached', async () => {
  const base = suitePreset(['one'])
  const f = fixture(base)
  f.dependencyRows.set('my-tools', { name: 'my-tools', source: 'manual', prepareCommand: 'manual', pathDirectories: ['bin'], stage: 'ready', updatedAt: 0, log: '', checks: [],
    current: { id: 'mine', identity: 'm', directory: '/p', mountedPath: '/m', commands: ['suite-cli'], commandPaths: {}, pathDirectories: ['bin'], bytes: 1, isolated: true, checks: [], log: '' } })
  f.suites.install(actor, { id: base.id, requestId: 'request-aaaaaaaaaaaa1', replace: [{ kind: 'runtime-dependency', name: 'my-tools' }] })
  await f.settled('installed')
  await f.suites.detach(actor, base.id, { kind: 'runtime-dependency', name: 'my-tools' })
  f.upgrade([{ ...base, version: '2' }])
  f.suites.update(actor, base.id)
  await expect.poll(() => f.record()?.version).toBe('2')
  expect(f.libraryRows.get('one')?.runtimeDependencies).toEqual(['my-tools'])
  expect(f.dependencyRows.get('my-tools')?.managedOrigin).toBeUndefined()
})
