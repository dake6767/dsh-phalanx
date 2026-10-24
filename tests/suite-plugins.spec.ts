import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginLibrary } from '../src/use-cases/plugin-library.js'
import { PluginAccessAdministration } from '../src/use-cases/plugin-access-administration.js'
import { SuitePlugins } from '../src/use-cases/suite-plugins.js'
import { FilePluginAccessStore } from '../src/adapters/plugin-access-store.js'
import { YamlPluginAccessSyntax } from '../src/adapters/plugin-access-syntax.js'
import type { LibraryPlugin, PreparedPlugin } from '../src/domain/plugin-library.js'
import type { SuiteCatalogEntry, SuiteCatalogSuiteEntry, SuiteCatalogPluginItem } from '../src/domain/suite-catalog.js'
import { actor, fixture, text } from './fixtures/suite-catalog.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const integrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64')
const item = (version = '1.0.0'): SuiteCatalogPluginItem => ({ kind: 'plugin', packageName: '@fixture/editor', version, integrity, runtimeDependencies: [], catalogDependencies: [], access: { environment: [{ name: 'EDITOR_MODE', value: version }], entriesYaml: '' } })
const preset = (version = '1.0.0'): SuiteCatalogSuiteEntry => ({ category: 'plugin', id: 'fixture-suite', version, title: text, description: text, identity: text, source: text, dependencies: [], items: [item(version)] })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'suite-plugin-')); roots.push(root)
  const rows = new Map<string, LibraryPlugin>()
  const store = { list: () => structuredClone([...rows.values()]), save: (row: LibraryPlugin) => { rows.set(row.packageName, structuredClone(row)) }, remove: (name: string) => { rows.delete(name) } }
  const accounts = { get: () => ({ ...actor, admin: true, disabled: false, email: '', groupId: 'admins', createdAt: 0, updatedAt: 0 }) }
  const accessStore = new FilePluginAccessStore(join(root, 'access.json'))
  const access = new PluginAccessAdministration(accounts, store, accessStore, { list: () => [] }, new YamlPluginAccessSyntax())
  let wait: Promise<void> | undefined, corrupt = false
  const prepared = (version: string): PreparedPlugin => ({ packageName: '@fixture/editor', version, integrity, artifact: 'fixture', runtimeRevision: 'rev', title: 'Editor', description: '', dependencies: {}, bundlePatch: '- insert:\n  - id: main\n    name: editor\n' })
  const revoked: string[] = []
  const library = new PluginLibrary(accounts, store, { prepare: async input => { await wait; return { ...prepared(input.version), ...(corrupt ? { integrity: 'wrong' } : {}) } } }, undefined,
    { impact: () => ({ groups: 1, members: 1, selectedMembers: 1 }), impactGroups: () => [{ id: 'team', name: 'Team' }], revoke: name => { revoked.push(name) } }, undefined, { access: accessStore, upstreams: { save: () => {} } })
  const port = new SuitePlugins(library, access)
  const f = fixture(preset(), [], { port, store })
  return { ...f, get suites() { return f.suites }, get state() { return f.state }, set state(value) { f.state = value }, rows, access, accessStore, library, port, prepared, revoked,
    block() { let release!: () => void; wait = new Promise(resolve => { release = resolve }); return release }, corrupt() { corrupt = true } }
}
const request = { id: 'fixture-suite', requestId: 'request-plugin-0000001' }
it('installs one owned plugin with access settings, deduplicates requests and supports uninstall', async () => {
  const f = setup()
  f.suites.install(actor, request); await f.settled('installed')
  expect(f.library.list(actor)).toMatchObject([{ packageName: '@fixture/editor', currentVersion: '1.0.0' }])
  expect(f.access.view(actor, '@fixture/editor').environment).toEqual([{ name: 'EDITOR_MODE', value: '1.0.0' }])
  expect(f.suites.install(actor, request).status).toBe('installed')
  expect(() => f.library.add(actor, { packageName: '@fixture/editor', version: '1.0.0' })).toThrow()
  expect(f.suites.uninstallPreview(actor, request.id).impact).toMatchObject([{ groups: [{ id: 'team' }], selectedMembers: 1 }])
  f.suites.uninstall(actor, request.id)
  await expect.poll(() => f.state.installs.length).toBe(0)
  expect(f.rows.size).toBe(0); expect(f.revoked).toEqual(['@fixture/editor'])
})
it('requires replacement confirmation and keeps publication and grants by replacing in place', async () => {
  const f = setup()
  f.rows.set('@fixture/editor', { packageName: '@fixture/editor', version: '0.9.0', current: f.prepared('0.9.0'), stage: 'available', published: true })
  const preview = f.suites.installPreview(actor, request.id)
  expect(preview.replacements).toMatchObject([{ kind: 'plugin', name: '@fixture/editor', revision: expect.any(String) }])
  expect(() => f.suites.install(actor, request)).toThrow()
  f.suites.install(actor, { ...request, replace: preview.replacements }); await f.settled('installed')
  expect(f.rows.get('@fixture/editor')).toMatchObject({ published: true, version: '1.0.0' })
  expect(f.revoked).toEqual([])
})
it('keeps a failed integrity check from changing the manual plugin or its configuration', async () => {
  const f = setup(); f.corrupt()
  const original: LibraryPlugin = { packageName: '@fixture/editor', version: '0.9.0', current: f.prepared('0.9.0'), stage: 'available', published: true }
  f.rows.set('@fixture/editor', original)
  f.access.save(actor, '@fixture/editor', { environment: [{ name: 'CUSTOM_MODE', value: 'manual' }], entriesYaml: '' })
  const before = f.accessStore.get('@fixture/editor')
  f.suites.install(actor, { ...request, replace: f.suites.installPreview(actor, request.id).replacements }); await f.settled('failed')
  expect(f.rows.get('@fixture/editor')).toEqual(original)
  expect(f.accessStore.get('@fixture/editor')).toEqual(before)
})
it('reserves a package before preparation against another entry and manual additions', async () => {
  const f = setup(), release = f.block()
  const other = { ...preset(), id: 'other' }
  f.upgrade([preset(), other])
  f.suites.install(actor, request)
  expect(() => f.suites.install(actor, { id: 'other', requestId: 'request-plugin-0000002' })).toThrow()
  expect(() => f.library.add(actor, { packageName: '@fixture/editor', version: '1.0.0' })).toThrow()
  release(); await f.settled('installed')
})
it('updates the package and template while preserving an administrator edit', async () => {
  const f = setup()
  f.suites.install(actor, request); await f.settled('installed')
  f.upgrade([preset('2.0.0')])
  expect(f.suites.updatePreview(actor, request.id).plugin).toMatchObject({ from: '1.0.0', to: '2.0.0', modified: false })
  f.suites.update(actor, request.id); await f.settled('installed')
  expect(f.rows.get('@fixture/editor')?.version).toBe('2.0.0')
  expect(f.accessStore.get('@fixture/editor')?.environment[0]?.value).toBe('2.0.0')
  f.access.save(actor, '@fixture/editor', { environment: [{ name: 'EDITOR_MODE', value: 'custom' }], entriesYaml: '' })
  f.upgrade([preset('3.0.0')])
  expect(f.suites.updatePreview(actor, request.id).plugin?.modified).toBe(true)
  f.suites.update(actor, request.id); await f.settled('installed')
  expect(f.rows.get('@fixture/editor')?.version).toBe('3.0.0')
  expect(f.accessStore.get('@fixture/editor')?.environment[0]?.value).toBe('custom')
})
it('detaches a plugin so ordinary edits and uninstall leave it in place', async () => {
  const f = setup()
  f.suites.install(actor, request); await f.settled('installed')
  await f.suites.detach(actor, request.id, { kind: 'plugin', name: '@fixture/editor' })
  expect(f.library.add(actor, { packageName: '@fixture/editor', version: '1.0.0' }).currentVersion).toBe('1.0.0')
  f.suites.uninstall(actor, request.id)
  await expect.poll(() => f.state.installs.length).toBe(0)
  expect(f.rows.get('@fixture/editor')?.version).toBe('1.0.0')
})

it('restores the exact original settings and plugin when a write fails after applying the template', async () => {
  const f = setup(), original: LibraryPlugin = { packageName: '@fixture/editor', version: '0.9.0', current: f.prepared('0.9.0'), stage: 'available', published: true }
  f.rows.set('@fixture/editor', original)
  f.access.save(actor, '@fixture/editor', { environment: [{ name: 'CUSTOM', value: 'manual' }], entriesYaml: '' })
  const settings = f.accessStore.get('@fixture/editor')
  const commit = f.port.commitSuitePlugin.bind(f.port)
  f.port.commitSuitePlugin = async (...args) => { await commit(...args); throw new Error('interrupted after plugin commit') }
  f.suites.install(actor, { ...request, replace: f.suites.installPreview(actor, request.id).replacements }); await f.settled('failed')
  expect(f.rows.get('@fixture/editor')).toEqual(original)
  expect(f.accessStore.get('@fixture/editor')).toEqual(settings)
  expect(f.accessStore.suiteCheckpoint('@fixture/editor')).toBeUndefined()
})
it('rolls a plugin update back after the package and template have switched', async () => {
  const f = setup()
  f.suites.install(actor, request); await f.settled('installed')
  const row = f.rows.get('@fixture/editor'), settings = f.accessStore.get('@fixture/editor')
  f.upgrade([preset('2.0.0')])
  const update = f.port.updateSuitePlugin.bind(f.port)
  f.port.updateSuitePlugin = async (...args) => { await update(...args); throw new Error('interrupted after switch') }
  f.suites.update(actor, request.id); await f.settled('installed')
  expect(f.rows.get('@fixture/editor')).toEqual(row)
  expect(f.accessStore.get('@fixture/editor')).toEqual(settings)
  expect(f.state.installs[0]?.version).toBe('1.0.0')
})
it('replays an interrupted detach and keeps its embedded resource when the entry is uninstalled', async () => {
  const f = setup()
  const base = preset(), plugin = { ...item(), runtimeDependencies: ['editor-sdk'], access: { environment: [{ name: 'EDITOR_SDK', value: '{dependency:editor-sdk}' }], entriesYaml: '' } }
  const resource = { kind: 'runtime-dependency' as const, type: 'resource' as const, name: 'editor-sdk', prepareCommands: { amd64: 'prepare-sdk' }, pathDirectories: [], commands: [] }
  f.upgrade([{ ...base, items: [resource, plugin] }])
  f.suites.install(actor, request); await f.settled('installed')
  const detach = f.port.detachSuitePlugin.bind(f.port)
  f.port.detachSuitePlugin = async (...args) => { await detach(...args); throw new Error('interrupted detach') }
  await expect(f.suites.detach(actor, request.id, { kind: 'plugin', name: '@fixture/editor' })).rejects.toThrow()
  expect(f.state.installs[0]?.status).toBe('detaching')
  f.port.detachSuitePlugin = detach
  await f.suites.recover()
  expect(f.state.installs[0]?.entries).toEqual([])
  f.suites.uninstall(actor, request.id)
  await expect.poll(() => f.state.installs.length).toBe(0)
  expect(f.rows.get('@fixture/editor')?.runtimeDependencies).toEqual(['editor-sdk'])
  expect(f.dependencyRows.get('editor-sdk')?.managedOrigin).toBeUndefined()
})
it('rejects an installed foreign catalog owner and preserves its plugin', async () => {
  const f = setup()
  f.suites.install(actor, request); await f.settled('installed')
  f.upgrade([preset(), { ...preset(), id: 'other-editor' }])
  expect(f.suites.installPreview(actor, 'other-editor')).toMatchObject({ reason: 'plugin-conflicts', pluginConflicts: ['@fixture/editor'] })
  expect(() => f.suites.install(actor, { ...request, id: 'other-editor', requestId: 'request-plugin-other-1' })).toThrow()
  expect(f.rows.get('@fixture/editor')?.suiteOrigin).toBe('suite:fixture-suite')
})
it('recovers a committed plugin even when the install record has not appended its entry', async () => {
  const f = setup()
  let intent = f.state
  const commit = f.port.commitSuitePlugin.bind(f.port), settle = f.port.settleSuitePlugin.bind(f.port)
  f.port.commitSuitePlugin = async (...args) => { intent = f.state; await commit(...args) }
  f.port.settleSuitePlugin = async () => { throw new Error('cleanup pending') }
  f.suites.install(actor, request); await f.settled('installed')
  expect(intent.installs[0]?.entries).toEqual([])
  f.state = intent
  await f.suites.recover()
  expect(f.rows.size).toBe(0)
  expect(f.accessStore.get('@fixture/editor')).toBeUndefined()
  expect(f.state.installs[0]?.status).toBe('failed')
  f.port.settleSuitePlugin = settle
})

it('keeps a dependency shared with a skill until the last catalog reference is removed', async () => {
  const f = setup()
  const shared: SuiteCatalogEntry = { category: 'dependency', id: 'shared', version: '1.0.0', title: text, description: text, source: text,
    items: [{ kind: 'runtime-dependency', name: 'shared-cli', prepareCommands: { amd64: 'prepare-shared' }, pathDirectories: ['bin'], commands: ['shared-cli'] }] }
  const skill: SuiteCatalogEntry = { category: 'suite', id: 'skill-entry', version: '1.0.0', title: text, description: text, source: text, identity: text, dependencies: ['shared'],
    items: [{ kind: 'skill', source: { type: 'git', url: 'https://git.example/repository', commit: 'a'.repeat(40), path: 'skills' }, names: ['one'], catalogDependencies: ['shared'] }] }
  f.upgrade([{ ...preset(), dependencies: ['shared'], items: [{ ...item(), catalogDependencies: ['shared'] }] }, shared, skill])
  f.suites.install(actor, request); await f.settled('installed')
  f.suites.install(actor, { id: 'skill-entry', requestId: 'request-shared-000001' })
  await expect.poll(() => f.state.installs.find(row => row.id === 'skill-entry')?.status).toBe('installed')
  expect(f.suites.uninstallPreview(actor, request.id).dependencies[0]?.references).toContainEqual({ kind: 'skill', name: 'one' })
  expect(() => f.suites.uninstall(actor, request.id, { removeDependencies: ['shared'] })).toThrow()
  f.suites.uninstall(actor, request.id)
  await expect.poll(() => f.state.installs.some(row => row.id === request.id)).toBe(false)
  expect(f.dependencyRows.has('shared-cli')).toBe(true)
  f.suites.uninstall(actor, 'skill-entry', { removeDependencies: ['shared'] })
  await expect.poll(() => f.dependencyRows.has('shared-cli')).toBe(false)
})
it('installs multiple embedded resources and resolves renamed dependencies during updates', async () => {
  const f = setup()
  // An unrelated manual resource already owns the preferred library name.
  f.dependencyRows.set('editor-sdk', { name: 'editor-sdk', type: 'resource', source: 'manual', prepareCommand: 'manual-sdk', pathDirectories: [], stage: 'failed', checks: [], log: '', updatedAt: 0 })
  const resources = ['editor-sdk', 'editor-fonts'].map(name => ({ kind: 'runtime-dependency' as const, type: 'resource' as const, name, prepareCommands: { amd64: 'prepare-' + name }, pathDirectories: [], commands: [] }))
  const plugin = { ...item(), runtimeDependencies: ['editor-sdk', 'editor-fonts'], access: { environment: [{ name: 'EDITOR_SDK', value: '{dependency:editor-sdk}' }], entriesYaml: '' } }
  f.upgrade([{ ...preset(), items: [...resources, plugin] }])
  f.suites.install(actor, request); await f.settled('installed')
  expect(f.rows.get('@fixture/editor')?.runtimeDependencies).toEqual(['editor-sdk-1', 'editor-fonts'])
  expect(f.accessStore.get('@fixture/editor')?.environment[0]?.value).toBe('{dependency:editor-sdk-1}')
  f.upgrade([{ ...preset('2.0.0'), items: [...resources.map(row => ({ ...row, prepareCommands: { amd64: 'updated-' + row.name } })), { ...plugin, version: '2.0.0' }] }])
  f.suites.update(actor, request.id); await f.settled('installed')
  expect(f.state.installs.find(row => row.id === request.id)?.version).toBe('2.0.0')
  expect(f.rows.get('@fixture/editor')?.runtimeDependencies).toEqual(['editor-sdk-1', 'editor-fonts'])
  expect(f.accessStore.get('@fixture/editor')?.environment[0]?.value).toBe('{dependency:editor-sdk-1}')
})

it('keeps the package reserved until its first configuration checkpoint settles', async () => {
  const f = setup(), settle = f.port.settleSuitePlugin.bind(f.port)
  f.port.settleSuitePlugin = async () => { throw new Error('checkpoint cleanup failed') }
  f.suites.install(actor, request); await f.settled('installed')
  expect(f.state.installs[0]?.pluginSettling).toBe(true)
  f.upgrade([preset('2.0.0')])
  expect(f.suites.updatePreview(actor, request.id).reason).toBe('task-running')
  expect(() => f.suites.update(actor, request.id)).toThrow()
  expect(() => f.suites.uninstall(actor, request.id)).toThrow()
  f.port.settleSuitePlugin = settle; await f.suites.recover()
  f.suites.update(actor, request.id); await f.settled('installed')
  expect(f.accessStore.get('@fixture/editor')?.environment[0]?.value).toBe('2.0.0')
})

it('updates a plugin while leaving its individually detached dependency manual', async () => {
  const f = setup(), resource = { kind: 'runtime-dependency' as const, type: 'resource' as const, name: 'editor-sdk', prepareCommands: { amd64: 'prepare-sdk' }, pathDirectories: [], commands: [] }
  const plugin = { ...item(), runtimeDependencies: ['editor-sdk'], access: { environment: [{ name: 'EDITOR_SDK', value: '{dependency:editor-sdk}' }], entriesYaml: '' } }
  f.upgrade([{ ...preset(), items: [resource, plugin] }])
  f.suites.install(actor, request); await f.settled('installed')
  await f.suites.detach(actor, request.id, { kind: 'runtime-dependency', name: 'editor-sdk' })
  const before = f.dependencyRows.get('editor-sdk')
  f.upgrade([{ ...preset('2.0.0'), items: [{ ...resource, prepareCommands: { amd64: 'updated-sdk' } }, { ...plugin, version: '2.0.0' }] }])
  expect(f.suites.updatePreview(actor, request.id).dependencyChanges).toEqual([])
  f.suites.update(actor, request.id); await f.settled('installed')
  expect(f.rows.get('@fixture/editor')?.version).toBe('2.0.0')
  expect(f.dependencyRows.get('editor-sdk')).toEqual(before)
})
it('refuses an update whose retained administrator settings reference a removed dependency', async () => {
  const f = setup(), resource = { kind: 'runtime-dependency' as const, type: 'resource' as const, name: 'editor-sdk', prepareCommands: { amd64: 'prepare-sdk' }, pathDirectories: [], commands: [] }
  const plugin = { ...item(), runtimeDependencies: ['editor-sdk'], access: { environment: [{ name: 'EDITOR_SDK', value: '{dependency:editor-sdk}' }], entriesYaml: '' } }
  f.upgrade([{ ...preset(), items: [resource, plugin] }])
  f.suites.install(actor, request); await f.settled('installed')
  f.access.save(actor, '@fixture/editor', { environment: [{ name: 'EDITOR_SDK', value: '{dependency:editor-sdk}/custom' }], entriesYaml: '' })
  f.upgrade([preset('2.0.0')]); f.suites.update(actor, request.id); await f.settled('installed')
  expect(f.rows.get('@fixture/editor')?.version).toBe('1.0.0')
  expect(f.accessStore.get('@fixture/editor')?.environment[0]?.value).toBe('{dependency:editor-sdk}/custom')
  expect(f.dependencyRows.has('editor-sdk')).toBe(true)
})

it('rejects a replacement confirmation after access settings have changed', () => {
  const f = setup()
  f.rows.set('@fixture/editor', { packageName: '@fixture/editor', version: '0.9.0', current: f.prepared('0.9.0'), stage: 'available', published: true })
  const preview = f.suites.installPreview(actor, request.id)
  f.access.save(actor, '@fixture/editor', { environment: [{ name: 'MODE', value: 'changed' }], entriesYaml: '' })
  expect(() => f.suites.install(actor, { ...request, replace: preview.replacements })).toThrow()
})
it('restores removed dependency rows when a switch fails after removing an old resource', async () => {
  const f = setup(), resource = { kind: 'runtime-dependency' as const, type: 'resource' as const, name: 'editor-sdk', prepareCommands: { amd64: 'prepare-sdk' }, pathDirectories: [], commands: [] }
  f.upgrade([{ ...preset(), items: [resource, { ...item(), runtimeDependencies: ['editor-sdk'] }] }])
  f.suites.install(actor, request); await f.settled('installed')
  const before = f.dependencyRows.get('editor-sdk'), remove = f.dependencies.removeManaged.bind(f.dependencies)
  let fail = true
  f.dependencies.removeManaged = async (...args) => { await remove(...args); if (fail) { fail = false; throw Error('interrupted after dependency removal') } }
  f.upgrade([preset('2.0.0')]); f.suites.update(actor, request.id); await f.settled('installed')
  expect(f.rows.get('@fixture/editor')?.version).toBe('1.0.0')
  expect(f.dependencyRows.get('editor-sdk')).toEqual(before)
})

it('updates a plugin dependency taken over from a differently named manual command provider', async () => {
  const f = setup(), tool = { kind: 'runtime-dependency' as const, name: 'editor-cli', prepareCommands: { amd64: 'prepare-cli' }, pathDirectories: ['bin'], commands: ['editor-cli'] }
  f.dependencyRows.set('manual-cli', { name: 'manual-cli', source: 'manual', prepareCommand: 'manual-cli', pathDirectories: ['bin'], stage: 'ready', checks: [], log: '', updatedAt: 0,
    current: { id: 'manual-version', identity: 'manual', directory: '/private/manual', mountedPath: '/mounted/manual', commands: ['editor-cli'], commandPaths: { 'editor-cli': '/mounted/manual/bin/editor-cli' }, pathDirectories: ['bin'], bytes: 1, isolated: true, checks: [], log: '' } })
  const plugin = { ...item(), runtimeDependencies: ['editor-cli'] }
  f.upgrade([{ ...preset(), items: [tool, plugin] }])
  f.suites.install(actor, { ...request, replace: f.suites.installPreview(actor, request.id).replacements }); await f.settled('installed')
  expect(f.rows.get('@fixture/editor')?.runtimeDependencies).toEqual(['manual-cli'])
  f.upgrade([{ ...preset('2.0.0'), items: [{ ...tool, prepareCommands: { amd64: 'prepare-cli-2' } }, { ...plugin, version: '2.0.0' }] }])
  f.suites.update(actor, request.id); await f.settled('installed')
  expect(f.state.installs[0]?.version).toBe('2.0.0')
  expect(f.rows.get('@fixture/editor')?.runtimeDependencies).toEqual(['manual-cli'])
})
