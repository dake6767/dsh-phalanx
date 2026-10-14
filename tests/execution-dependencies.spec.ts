import { expect, it } from 'vitest'
import { ExecutionAdministration } from '../src/use-cases/execution-administration.js'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import type { RuntimeDependency } from '../src/domain/runtime-dependency.js'
import { ExecutionDependencies } from '../src/use-cases/execution-dependencies.js'
import type { ExecutionConfiguration } from '../src/domain/platform-execution.js'
import type { RuntimeDependencyVersion } from '../src/domain/runtime-dependency.js'

it('migrates each legacy definition once, removes preparation from execution and keeps its old artifact until dependencies become usable', async () => {
  let config: ExecutionConfiguration = { enabled: true, commands: [{ command: 'news', blocked: [] }], variables: [{ name: 'KEY', value: 'secret', secret: true }], prepare: 'install-news' }
  let ready = false, imports = 0, retained = true
  const legacy = { id: 'old', version: 'v1', hash: 'hash', log: 'old preparation' }, references: string[] = []
  const artifact = { id: 'new', identity: 'new', directory: '/host/new', mountedPath: '/fixed/new', pathDirectories: ['bin'], commands: ['news'], commandPaths: { news: 'bin/news' }, bytes: 1, isolated: true, checks: [], log: '' } as RuntimeDependencyVersion
  const service = new ExecutionDependencies({ identities: () => ['skill:news'], get: id => ({ id, version: 'v2' }), owns: () => true }, {
    get: () => config, list: () => [{ owner: 'skill:news', configuration: config }], save: (_, value) => { config = value }, retain: () => {},
  }, { list: () => retained ? [{ identity: 'old', stage: 'ready', updatedAt: 1, log: '', artifact: legacy }] : [], get: () => retained ? { identity: 'old', stage: 'ready', updatedAt: 1, log: '', artifact: legacy } : undefined, save: () => {}, retain: names => { retained = names.includes('skill:news') } },
  { pathDirectories: async () => ['bin'], collect: async ids => { references.splice(0, references.length, ...ids) } }, {
    updateSource: () => {},
    migrate: (_, input, source) => { imports++; expect(input).toMatchObject({ prepareCommand: 'install-news', pathDirectories: ['bin'] }); expect(JSON.stringify(input)).not.toContain('secret'); expect(source).toBe('v2'); return 'migrated-news' },
    state: () => ({ stage: ready ? 'ready' : 'failed', updatedAt: 1, log: 'no credentials during preparation' }),
    ready: () => { if (!ready) throw new Error('not ready'); return [artifact] },
    withPrepared: async (_, run) => run([artifact]),
  })
  await service.recover(); await service.recover()
  expect(imports).toBe(1); expect(config).not.toHaveProperty('prepare'); expect(config.runtimeDependencies).toEqual(['migrated-news'])
  expect(service.view('skill:news')).toMatchObject({ stage: 'failed', usingPrevious: true })
  await service.withPrepared('skill:news', async material => { expect(material).toMatchObject({ id: 'old', version: 'v1' }) })
  expect(references).toContain('old')
  config = { ...config, variables: [{ name: 'KEY', value: 'replacement', secret: true }] }; await service.changed(); expect(imports).toBe(1)
  ready = true
  await service.withPrepared('skill:news', async material => { expect(material).toMatchObject({ version: 'v2', dependencies: [artifact] }); expect(material.id).toBeUndefined() })
  expect(references).not.toContain('old'); expect(retained).toBe(false)
})

it('holds a source version for an admitted call while its skill changes and shutdown waits for that call', async () => {
  let version = 'source-one', release!: () => void, stopped = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const configuration = { enabled: true, commands: [{ command: 'run', blocked: [] }], variables: [] }
  const service = new ExecutionDependencies({ identities: () => ['skill:reports'], get: id => ({ id, version }), owns: () => true },
    { get: () => configuration, list: () => [{ owner: 'skill:reports', configuration }], save: () => {}, retain: () => {} },
    { get: () => undefined, list: () => [], save: () => {}, retain: () => {} }, { pathDirectories: async () => ['bin'], collect: async () => {} },
    { updateSource: () => {}, migrate: () => '', state: () => ({ stage: 'ready', updatedAt: 0, log: '' }), ready: () => [], withPrepared: async (_, run) => run([]) })
  const call = service.withPrepared('skill:reports', async material => { expect(material.version).toBe('source-one'); await gate })
  version = 'source-two'; await service.changed()
  expect(service.sourceVersions()).toEqual(['source-one'])
  const stopping = service.stop().then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false)
  release(); await call; await stopping
  expect(service.sourceVersions()).toEqual([])
  await expect(service.withPrepared('skill:reports', async () => {})).rejects.toMatchObject({ code: 'internal' })
})

it('waits for execution approval before preparing a newly contributed source', async () => {
  let configuration: ExecutionConfiguration = { enabled: true, commands: [], variables: [], runtimeDependencies: ['news'], awaitingPreparation: true }
  const synchronized: string[] = []
  const service = new ExecutionDependencies({ identities: () => ['skill:news'], get: id => ({ id, version: 'new-source', preparationApproval: 'receipt' }), owns: () => true },
    { get: () => configuration, list: () => [{ owner: 'skill:news', configuration }], save: () => {}, retain: () => {} },
    { get: () => undefined, list: () => [], save: () => {}, retain: () => {} }, { pathDirectories: async () => [], collect: async () => {} },
    { updateSource: (_, version) => { synchronized.push(version) }, migrate: () => '', state: () => ({ migrationOrigin: 'skill:news', stage: 'ready', updatedAt: 0, log: '' }), ready: () => [], withPrepared: async (_, run) => run([]) })
  await service.changed(); expect(synchronized).toEqual([])
  configuration = { ...configuration, awaitingPreparation: false }
  await service.changed(); expect(synchronized).toEqual([])
  configuration = { ...configuration, approvedContribution: 'receipt' }
  await service.changed(); expect(synchronized).toEqual(['new-source'])
})

it('defers legacy migration until contribution approval, including recovery followed by background startup', async () => {
  let configuration: ExecutionConfiguration = { enabled: true, commands: [], variables: [], prepare: 'install', awaitingPreparation: true }
  const rows = new Map<string, RuntimeDependency>(), prepared: string[] = []
  let completed!: () => void
  const ready = new Promise<void>(resolve => { completed = resolve })
  const dependencies = new RuntimeDependencies({ get: () => undefined }, {
    list: () => [...rows.values()], save: row => { rows.set(row.name, row); if (row.stage === 'ready') completed() }, remove: name => { rows.delete(name) },
  }, { isolated: true, identity: definition => definition.sourceVersion!, recover: async () => {}, collect: async () => {}, prepare: async definition => {
    prepared.push(definition.sourceVersion!)
    return { id: 'new', identity: definition.sourceVersion!, directory: '/host', mountedPath: '/fixed', pathDirectories: ['bin'], commands: [], commandPaths: {}, bytes: 0, isolated: true, checks: [], log: '' }
  } }, { now: () => 0 })
  const service = new ExecutionDependencies({ identities: () => ['skill:news'], get: id => ({ id, version: 'contributed', preparationApproval: 'receipt' }), owns: () => true },
    { get: () => configuration, list: () => [{ owner: 'skill:news', configuration }], save: (_, value) => { configuration = value }, retain: () => {} },
    { get: () => undefined, list: () => [], save: () => {}, retain: () => {} }, { pathDirectories: async () => ['bin'], collect: async () => {} }, dependencies)
  await service.recover(); dependencies.start()
  expect(rows.size).toBe(0); expect(prepared).toEqual([])
  configuration = { ...configuration, awaitingPreparation: false }
  await service.changed(); expect(rows.size).toBe(0)
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const administration = new ExecutionAdministration({ get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    { get: id => ({ id, version: 'contributed', preparationApproval: 'receipt' }), owns: () => true },
    { get: () => configuration, list: () => [{ owner: 'skill:news', configuration }], save: (_, value) => { configuration = value } }, () => service.changed(), service)
  await administration.save(actor, 'skill:news', { enabled: true, commands: [{ command: 'news', blocked: [] }], variables: [{ name: 'KEY', value: 'replacement', secret: true }] })
  expect(configuration.prepare).toBe('install'); expect(rows.size).toBe(0)
  await administration.reprepare(actor, 'skill:news'); await ready
  expect(prepared).toEqual(['contributed']); expect(configuration).not.toHaveProperty('prepare')
  await dependencies.stop(); await service.stop()
})

it('preserves configuration saved while legacy artifact inspection is pending', async () => {
  let configuration: ExecutionConfiguration = { enabled: true, commands: [], variables: [], prepare: 'install' }
  let release!: () => void, inspecting!: () => void
  const entered = new Promise<void>(resolve => { inspecting = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const service = new ExecutionDependencies({ identities: () => ['skill:news'], get: id => ({ id, version: 'source' }), owns: () => true },
    { get: () => configuration, list: () => [{ owner: 'skill:news', configuration }], save: (_, value) => { configuration = value }, retain: () => {} },
    { get: () => undefined, list: () => [], save: () => {}, retain: () => {} },
    { pathDirectories: async () => { inspecting(); await gate; return ['bin'] }, collect: async () => {} },
    { migrate: () => 'news', updateSource: () => {}, state: () => ({ stage: 'ready', updatedAt: 0, log: '' }), ready: () => [], withPrepared: async (_, run) => run([]) })
  const migration = service.recover(); await entered
  configuration = { ...configuration, enabled: false, variables: [{ name: 'KEY', value: 'latest', secret: true }] }
  release(); await migration
  expect(configuration).toMatchObject({ enabled: false, variables: [{ value: 'latest' }], runtimeDependencies: ['news'] })
})
