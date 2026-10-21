import { expect, it } from 'vitest'
import { McpRuntimeDependencies } from '../src/use-cases/mcp-runtime-dependencies.js'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import type { RuntimeDependency } from '../src/domain/runtime-dependency.js'
import type { McpService } from '../src/domain/mcp-service.js'

const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
it('migrates shared MCP preparation without credentials and keeps its prepared version when credentials rotate', async () => {
  const rows = new Map<string, RuntimeDependency>(), inputs: unknown[] = []
  const dependencies = new RuntimeDependencies({ get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    { list: () => [...rows.values()], save: row => { rows.set(row.name, row) }, remove: name => { rows.delete(name) } },
    { isolated: true, identity: input => input.prepareCommand, recover: async () => {}, collect: async () => {}, prepare: async input => {
      inputs.push(input)
      return { id: 'version-one', identity: input.prepareCommand, directory: '/host/version-one', mountedPath: '/fixed/version-one', pathDirectories: ['bin'], commands: ['p-search'], commandPaths: { 'p-search': 'bin/p-search' }, bytes: 1, isolated: true, checks: [], log: '' }
    } }, { now: () => 0 })
  let services: readonly McpService[] = [{ name: 'p-search', description: '', url: '', generation: 1, credential: 'private-key', run: { location: 'shared', command: 'search', args: [], env: [{ name: 'KEY', value: '{credential}' }], prepareCommand: 'install-pinned' } }]
  const runtime = new McpRuntimeDependencies({ read: () => ({ services, grants: {} }) }, dependencies)
  services = services.map(service => runtime.configure(service))
  const service = services[0]!
  expect(service.run).not.toHaveProperty('prepareCommand')
  expect(service.run?.runtimeDependencies).toHaveLength(1)
  dependencies.start(); await dependencies.prepare(actor, service.run!.runtimeDependencies![0]!)
  expect(JSON.stringify(inputs)).not.toContain('private-key'); expect(JSON.stringify(inputs)).not.toContain('credential')
  expect(runtime.ready(service)).toMatchObject({ directory: '/fixed/version-one', dependencies: [{ id: 'version-one' }] })
  services = [{ ...service, credential: 'rotated-key', generation: 2 }]
  services = services.map(value => runtime.configure(value)); await runtime.changed()
  expect(inputs).toHaveLength(1); expect(runtime.ready(services[0]!)).toEqual(runtime.ready(service))
  await dependencies.stop()
})

it('keeps the active catalog dependency during candidate preparation and activates the tested candidate with stable references', async () => {
  const rows = new Map<string, RuntimeDependency>()
  let serial = 0, release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const dependencies = new RuntimeDependencies({ get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    { list: () => [...rows.values()], save: row => { rows.set(row.name, row) }, remove: name => { rows.delete(name) } },
    { isolated: true, identity: input => input.prepareCommand, recover: async () => {}, collect: async () => {}, prepare: async input => {
      const id = `version-${++serial}`
      if (serial === 3) { entered(); await blocked }
      return { id, identity: input.prepareCommand, directory: '/host/' + id, mountedPath: '/fixed/' + id, pathDirectories: ['bin'], commands: ['mcp-p-train'], commandPaths: { 'mcp-p-train': 'bin/mcp-p-train' }, bytes: 1, isolated: true, checks: [], log: '' }
    } }, { now: () => 0 })
  let services: readonly McpService[] = []
  const runtime = new McpRuntimeDependencies({ read: () => ({ services, grants: {} }) }, dependencies)
  const original = runtime.configure({ name: 'p-train', description: '', url: '', generation: 1, catalog: { id: 'train', version: '1', status: 'ready' }, run: { location: 'member', command: 'node', args: ['server.js'], env: [], prepareCommand: 'install-one' } })
  services = [original]; dependencies.start(); await dependencies.prepare(actor, original.dependencyName!)
  const candidate = runtime.configure({ ...original, name: 'p-update-2', preparationName: 'catalog-update:2', dependencyTarget: original.dependencyName!, generation: 2, run: { ...original.run!, prepareCommand: 'install-two', runtimeDependencies: [] } } as McpService)
  expect(runtime.ready(original)?.directory).toBe('/fixed/version-1')
  await dependencies.restartManaged(candidate.dependencyName!)
  expect(dependencies.list(actor).map(row => row.name)).not.toContain(candidate.dependencyName)
  expect(() => dependencies.ready([candidate.dependencyName!])).toThrow()
  expect(() => dependencies.prepare(actor, candidate.dependencyName!)).toThrow()
  expect(runtime.ready(candidate)?.directory).toBe('/fixed/version-2')
  expect(dependencies.ready([original.dependencyName!])[0]?.id).toBe('version-1')
  const retry = dependencies.prepare(actor, original.dependencyName!)
  await started
  const promoted = runtime.promote(candidate, original)
  // The service owner persists this promotion intent before changing the shared library.
  services = [{ ...promoted, name: original.name }]
  services = services.map(value => runtime.configure(value))
  expect(services[0]!.dependencyName).toBe(original.dependencyName)
  expect(runtime.ready(services[0]!)?.directory).toBe('/fixed/version-2')
  expect(dependencies.ready([original.dependencyName!])[0]?.id).toBe('version-2')
  services = services.map(value => runtime.configure(value))
  release(); await retry
  expect(dependencies.ready([original.dependencyName!])[0]?.id).toBe('version-2')
  expect(rows.get(original.dependencyName!)?.prepareCommand).toContain('install-two')
  expect(serial).toBe(3)
  expect(() => dependencies.update(actor, original.dependencyName!, { name: original.dependencyName!, prepareCommand: 'changed', pathDirectories: ['bin'] })).toThrow(expect.objectContaining({ code: 'runtime-dependency-locked' }))
  await dependencies.stop()
})

it('keeps a catalog candidate private when the previous remote service has no dependency', async () => {
  const rows = new Map<string, RuntimeDependency>()
  const dependencies = new RuntimeDependencies({ get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    { list: () => [...rows.values()], save: row => { rows.set(row.name, row) }, remove: name => { rows.delete(name) } },
    { isolated: true, identity: input => input.prepareCommand, recover: async () => {}, collect: async () => {}, prepare: async input => ({ id: 'local-version', identity: input.prepareCommand, directory: '/host/local', mountedPath: '/fixed/local', pathDirectories: ['bin'], commands: ['tool'], commandPaths: { tool: 'bin/tool' }, bytes: 1, isolated: true, checks: [], log: '' }) }, { now: () => 0 })
  let services: readonly McpService[] = []
  const runtime = new McpRuntimeDependencies({ read: () => ({ services, grants: {} }) }, dependencies)
  const previous: McpService = { name: 'p-search', description: '', url: 'https://example.test', generation: 1, catalog: { id: 'search', version: '1', status: 'ready' } }
  const candidate = runtime.configure({ ...previous, name: 'p-update-2', preparationName: 'catalog-update:2', generation: 2, run: { location: 'shared', command: 'tool', args: [], env: [], prepareCommand: 'install' } })
  await dependencies.restartManaged(candidate.dependencyName!)
  expect(dependencies.list(actor)).toEqual([])
  expect(() => dependencies.ready([candidate.dependencyName!])).toThrow()
  expect(() => dependencies.prepare(actor, candidate.dependencyName!)).toThrow()
  expect(runtime.ready(candidate)?.directory).toBe('/fixed/local')
  const persistedIntent = runtime.promote(candidate, previous)
  runtime.configure(persistedIntent) // Library commit succeeded, service intent write was interrupted.
  services = [runtime.configure(persistedIntent)]
  expect(dependencies.list(actor).map(row => row.name)).toEqual([candidate.dependencyName])
  expect(dependencies.ready([candidate.dependencyName!])[0]?.id).toBe('local-version')
  await dependencies.stop()
})

it('reuses MCP preparation with real legacy collection while keeping authorization versions conservative', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const { McpMigrationArtifacts } = await import('../src/adapters/mcp-migration-artifacts.js'), { McpServices } = await import('../src/use-cases/mcp-services.js')
  const root = await mkdtemp(join(tmpdir(), 'mcp-preparation-cache-'))
  const account = { ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  const accounts = { get: () => account, list: () => [account], listGroups: () => [{ id: 'admin', name: 'Admin', kind: 'admin' as const, isDefault: false, memberCount: 1 }] }
  let dependencyVersion = 0, projections = 0, skills = 0
  const dependencies = new RuntimeDependencies(accounts,
    { version: () => dependencyVersion, list: () => [], save: () => {}, remove: () => {} },
    { isolated: true, identity: () => 'fixture', recover: async () => {}, collect: async () => {}, prepare: async () => { throw Error('No preparation needed') } }, { now: () => 0 })
  const legacy = new McpMigrationArtifacts({ dataRoot: root, command: 'fixture', args: [], defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'http://localhost' } } }, () => false, () => [], () => true)
  const store = { read: () => ({ services: [], grants: {} }), write: () => {} }
  const runtime = new McpRuntimeDependencies(store, dependencies, { legacy })
  const service = new McpServices(accounts, store, { synchronize: async () => { projections++ } }, runtime, undefined, async () => { skills++ })
  try {
    const initial = runtime.version()
    await service.prepare(); await service.prepare()
    expect(runtime.version()).not.toBe(initial)
    expect({ projections, skills }).toEqual({ projections: 1, skills: 1 })
    dependencyVersion++; await service.prepare()
    expect({ projections, skills }).toEqual({ projections: 2, skills: 2 })
  } finally { await service.stop(); await dependencies.stop(); await rm(root, { recursive: true, force: true }) }
})
