import { fixtureGallery } from './fixtures/suite-gallery.js'
import { expect, it } from 'vitest'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import { SuiteCatalog } from '../src/use-cases/suite-catalog.js'
import type { SuiteCatalogEntry } from '../src/domain/suite-catalog.js'
import type { SuiteInstallState } from '../src/domain/suite-install.js'
import { suiteInstallOrigin } from '../src/domain/suite-install.js'
import type { RuntimeDependency, RuntimeDependencyReference, RuntimeDependencyVersion } from '../src/domain/runtime-dependency.js'
import { RuntimeDependencyPreparationFailure } from '../src/domain/runtime-dependency.js'

const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
const text = { en: 'entry', 'zh-CN': '条目' }
const presets: readonly SuiteCatalogEntry[] = [
  { category: 'dependency', id: 'pandoc', version: '1', title: text, description: text, source: text,
    items: [{ kind: 'runtime-dependency', name: 'pandoc', prepareCommands: { amd64: 'install-pandoc' }, pathDirectories: ['bin'], checkCommand: 'pandoc --version', commands: ['pandoc'] }] },
  { category: 'dependency', id: 'arm-only', version: '1', title: text, description: text, source: text,
    items: [{ kind: 'runtime-dependency', name: 'armtool', prepareCommands: { arm64: 'install-arm' }, pathDirectories: ['bin'], commands: ['armtool'] }] },
]

type GalleryStub = { entries(): readonly SuiteCatalogEntry[], source(): { status: 'ok' | 'unreachable' | 'rejected', address: string, reason?: string, publishedAt?: string }, load(): Promise<{ status: 'ok' | 'unreachable' | 'rejected', address: string, reason?: string, publishedAt?: string }> }
function fixture(architecture: 'amd64' | 'arm64' = 'amd64', gallery?: GalleryStub) {
  const rows = new Map<string, RuntimeDependency>()
  const references: RuntimeDependencyReference[] = []
  let state: SuiteInstallState = { installs: [] }
  let calls = 0, failure = false
  const collected: string[][] = []
  const accounts = { get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) }
  const dependencies = new RuntimeDependencies(accounts,
    { list: () => structuredClone([...rows.values()]), save: row => { rows.set(row.name, structuredClone(row)) }, remove: name => { rows.delete(name) } },
    { isolated: true, recover: async () => {}, identity: definition => definition.prepareCommand, collect: async retained => { collected.push([...retained]) },
      prepare: async definition => {
        calls++
        if (failure) throw new RuntimeDependencyPreparationFailure('check-failed', 'check exited 1')
        return { id: `version-${calls}`, identity: definition.prepareCommand, directory: '/private/artifact', mountedPath: '/fixed/artifact', commands: [definition.name], commandPaths: { [definition.name]: `bin/${definition.name}` }, pathDirectories: definition.pathDirectories, bytes: 42, isolated: true, checks: [{ kind: 'check-command', passed: true }], log: `prepared ${definition.prepareCommand}\n` } satisfies RuntimeDependencyVersion } },
    { now: () => 100 }, { list: name => name === 'pandoc' ? references : [] })
  const suites = new SuiteCatalog(accounts, gallery ?? fixtureGallery(presets), { read: () => structuredClone(state), write: next => { state = structuredClone(next) } }, dependencies, { now: () => 100 }, architecture,
    { prepareSuiteImport: async () => {}, suiteSkillConflicts: () => [], commitSuiteSkills: async () => [], discardSuiteImport: async () => {}, removeSuiteSkills: async () => {}, detachSuiteSkill: async () => {}, suiteReplaceable: () => [], restoreSuiteSkills: async () => {} },
    { commitSuitePack: async () => {}, removeSuitePack: async () => {}, detachSuitePack: async () => {}, applySuiteOptions: async () => {}, suiteImpact: () => undefined, manualPacksContaining: () => [], suitePackConflicts: () => [] },
    undefined)
  const record = () => state.installs.find(row => row.id === 'pandoc')
  return { suites, dependencies, rows, references, collected, get calls() { return calls }, fail() { failure = true }, restore() { failure = false }, record,
    get state() { return state }, set state(next: SuiteInstallState) { state = structuredClone(next) },
    status: () => record()?.status,
    async settled(status: 'installed' | 'failed'): Promise<void> {
      await expect.poll(() => record()?.status).toBe(status)
    } }
}

it('previews, installs and records a catalog dependency as a read-only library row', async () => {
  const f = fixture()
  const preview = f.suites.installPreview(actor, 'pandoc')
  expect(preview).toMatchObject({ id: 'pandoc', version: '1', available: true, creates: [{ kind: 'runtime-dependency', name: 'pandoc', commands: ['pandoc'] }] })
  f.suites.install(actor, { id: 'pandoc', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('installed')
  expect(f.record()).toMatchObject({ id: 'pandoc', version: '1', status: 'installed', entries: [{ kind: 'runtime-dependency', name: 'pandoc' }] })
  expect(f.dependencies.list(actor)[0]).toMatchObject({ name: 'pandoc', source: 'suite-catalog', stage: 'ready' })
  expect(f.rows.get('pandoc')?.managedOrigin).toBe(suiteInstallOrigin('pandoc'))
  expect(f.suites.catalog(actor).entries.find(entry => entry.id === 'pandoc')).toMatchObject({ installedVersion: '1', available: true })
})

it('dedups repeated requests, rejects duplicates and replays of retired receipts', async () => {
  const f = fixture()
  const first = f.suites.install(actor, { id: 'pandoc', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('installed')
  expect(f.suites.install(actor, { id: 'pandoc', requestId: 'request-aaaaaaaaaaaa1' })).toMatchObject({ id: 'pandoc', updatedAt: first.updatedAt })
  expect(f.calls).toBe(1)
  expect(() => f.suites.install(actor, { id: 'pandoc', requestId: 'request-bbbbbbbbbbbb2' })).toThrow(expect.objectContaining({ code: 'suite-already-installed' }))
  f.references.length = 0
  f.suites.uninstall(actor, 'pandoc')
  await expect.poll(() => f.rows.size).toBe(0)
  await expect.poll(() => f.suites.catalog(actor).installations.length).toBe(0)
  expect(() => f.suites.install(actor, { id: 'pandoc', requestId: 'request-aaaaaaaaaaaa1' })).toThrow(expect.objectContaining({ code: 'suite-request-retired' }))
})

it('rolls back a failed install completely, keeps the log and retries', async () => {
  const f = fixture(); f.fail()
  f.suites.install(actor, { id: 'pandoc', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('failed')
  expect(f.rows.size).toBe(0)
  const failed = f.record()
  expect(failed).toMatchObject({ status: 'failed', failureCode: 'check-failed' })
  expect(failed?.log).toContain('Preparing runtime dependency pandoc')
  expect(failed?.log).toContain('check exited 1')
  f.restore()
  f.suites.install(actor, { id: 'pandoc', requestId: 'request-cccccccccccc3' })
  await f.settled('installed')
  expect(f.rows.get('pandoc')).toMatchObject({ source: 'suite-catalog', stage: 'ready' })
  expect(f.record()?.log).toContain('---')
})

it('rejects entries without a preparation for the current architecture', async () => {
  const f = fixture('arm64')
  expect(f.suites.installPreview(actor, 'arm-only')).toMatchObject({ available: true })
  expect(f.suites.installPreview(actor, 'pandoc')).toMatchObject({ available: false, reason: 'unavailable-architecture' })
  expect(() => f.suites.install(actor, { id: 'pandoc', requestId: 'request-aaaaaaaaaaaa1' })).toThrow(expect.objectContaining({ code: 'suite-arch-unavailable' }))
  expect(f.suites.catalog(actor).entries.find(entry => entry.id === 'pandoc')?.available).toBe(false)
  expect(f.suites.catalog(actor).installations).toHaveLength(0)
})

it('blocks uninstall while referenced and removes entries after confirmation', async () => {
  const f = fixture()
  f.suites.install(actor, { id: 'pandoc', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('installed')
  f.references.push({ kind: 'skill', name: 'reports' })
  expect(f.suites.uninstallPreview(actor, 'pandoc')).toMatchObject({ removes: [{ kind: 'runtime-dependency', name: 'pandoc' }], blocked: [{ name: 'pandoc', references: [{ kind: 'skill', name: 'reports' }] }] })
  expect(() => f.suites.uninstall(actor, 'pandoc')).toThrow(expect.objectContaining({ code: 'runtime-dependency-referenced' }))
  expect(f.record()?.status).toBe('installed')
  f.references.length = 0
  f.suites.uninstall(actor, 'pandoc')
  await expect.poll(() => f.suites.catalog(actor).installations.length).toBe(0)
  expect(f.rows.size).toBe(0)
})

it('locks suite-owned library rows against direct edits and deletion', async () => {
  const f = fixture()
  f.suites.install(actor, { id: 'pandoc', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('installed')
  expect(() => f.dependencies.update(actor, 'pandoc', { name: 'pandoc', prepareCommand: 'tampered', pathDirectories: ['bin'] })).toThrow(expect.objectContaining({ code: 'suite-entry-locked' }))
  await expect(f.dependencies.remove(actor, 'pandoc')).rejects.toMatchObject({ code: 'suite-entry-locked' })
  expect(f.rows.get('pandoc')?.prepareCommand).toBe('install-pandoc')
})

it('recovers interrupted installs by rolling back committed rows', async () => {
  const f = fixture()
  f.suites.install(actor, { id: 'pandoc', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('installed')
  let state = { installs: [{ ...structuredClone(f.record()!), status: 'installing' as const, entries: [] }] } as SuiteInstallState
  const recovering = new SuiteCatalog({ get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) }, fixtureGallery(presets),
    { read: () => structuredClone(state), write: next => { state = structuredClone(next) } }, f.dependencies, { now: () => 100 }, 'amd64',
    { prepareSuiteImport: async () => {}, suiteSkillConflicts: () => [], commitSuiteSkills: async () => [], discardSuiteImport: async () => {}, removeSuiteSkills: async () => {}, detachSuiteSkill: async () => {}, suiteReplaceable: () => [], restoreSuiteSkills: async () => {} },
    { commitSuitePack: async () => {}, removeSuitePack: async () => {}, detachSuitePack: async () => {}, applySuiteOptions: async () => {}, suiteImpact: () => undefined, manualPacksContaining: () => [], suitePackConflicts: () => [] })
  await recovering.recover()
  expect(f.rows.size).toBe(0)
  expect(state.installs[0]).toMatchObject({ status: 'failed', failureCode: 'interrupted' })
})

it('exposes the online source state and declared runtime service addresses to administrators', () => {
  const entry: SuiteCatalogEntry = { category: 'suite', id: 'online-suite', version: '1.2.3', title: text, description: text, source: text, identity: text,
    dependencies: [], serviceAddresses: ['https://api.example.test'], items: [] }
  const source = { status: 'unreachable' as const, address: 'https://catalog.example.test/catalog.json', reason: 'offline' }
  const f = fixture('amd64', { entries: () => [entry], source: () => source, load: async () => source })
  const view = f.suites.catalog(actor)
  expect(view.source).toEqual({ status: 'unreachable', address: 'https://catalog.example.test/catalog.json', reason: 'offline' })
  expect(view.entries.find(row => row.id === 'online-suite')).toMatchObject({ version: '1.2.3', serviceAddresses: ['https://api.example.test'], available: true })
})

it('offers the declarative entry as an update over a legacy 0.1.18 record', () => {
  // 0.1.18 installed wecom as version "1"; the online declarative entry is 2.0.0 with equal content.
  const online: SuiteCatalogEntry = { category: 'suite', id: 'wecom', version: '2.0.0', title: text, description: text, source: text, identity: text, dependencies: [], items: [] }
  const f = fixture('amd64', { entries: () => [online], source: () => ({ status: 'ok', address: 'https://catalog.example.test/catalog.json' }), load: async () => ({ status: 'ok', address: 'https://catalog.example.test/catalog.json' }) })
  f.state = { installs: [{ id: 'wecom', version: '1', status: 'installed', entries: [], updatedAt: 0, log: '' }] }
  expect(f.suites.catalog(actor).entries.find(row => row.id === 'wecom')).toMatchObject({ version: '2.0.0', installedVersion: '1', updateAvailable: true })
})


it('keeps 0.1.23 tool and standalone dependency records unchanged when recovering with the catalog offline', async () => {
  const offline = { status: 'unreachable' as const, address: 'https://catalog.example.test/catalog.json' }
  const f = fixture('amd64', { entries: () => [], source: () => offline, load: async () => offline })
  // Persisted record fields match the released 0.1.23 schema; no migration is needed for the library entry point.
  const records: SuiteInstallState = { installs: [
    ...['lark', 'wecom', 'minimax', 'officecli', 'hyperframes'].map(id => ({ id, category: 'suite' as const, version: '1.0.0', status: 'installed' as const,
      entries: [{ kind: 'skill' as const, name: `${id}-skill` }], updatedAt: 123, log: 'installed', requestId: `previous-${id}`, contentHash: 'a'.repeat(64) })),
    { id: 'pandoc', category: 'dependency', version: '1.0.0', status: 'installed', entries: [{ kind: 'runtime-dependency', name: 'pandoc' }], updatedAt: 123, log: 'installed' },
  ] }
  f.state = records
  await f.suites.recover()
  const view = f.suites.catalog(actor)
  expect(view.installations.filter(row => row.category === 'suite').map(row => row.id)).toEqual(['lark', 'wecom', 'minimax', 'officecli', 'hyperframes'])
  expect(view.installations.find(row => row.id === 'pandoc')).toMatchObject({ category: 'dependency', version: '1.0.0', status: 'installed', entries: [{ kind: 'runtime-dependency', name: 'pandoc' }] })
  expect(f.state).toEqual(records)
})
