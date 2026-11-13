import { expect, it } from 'vitest'
import { SuiteAvailability } from '../src/use-cases/suite-availability.js'
import { suitePreset } from './fixtures/suite-catalog.js'
import { runtimeVersion } from './fixtures/runtime-version.js'
import type { RuntimeDependency } from '../src/domain/runtime-dependency.js'
import type { SuiteInstallRecord } from '../src/domain/suite-install.js'

it('waits for the asynchronous provider plan and awaits an unavailable shared architecture', async () => {
  const base = suitePreset(),
    dependency = {
      ...base,
      id: 'dependency',
      category: 'dependency' as const,
      items: base.items.filter(row => row.kind === 'runtime-dependency').map(row => ({ ...row, name: 'catalog-only' })),
    },
    suite = { ...base, dependencies: ['dependency'] }
  let release!: (rows: readonly RuntimeDependency[]) => void,
    entered!: () => void,
    resolved = false
  const began = new Promise<void>(resolve => {
    entered = resolve
  })
  const availability = new SuiteAvailability(
    () => [suite, dependency],
    async () => [],
    {
      manualProviders: async () => {
        entered()
        return new Promise(resolve => {
          release = resolve
        })
      },
      commandOwners: async () => [],
    },
    item => item.kind !== 'runtime-dependency' || item.name !== 'catalog-only',
  )
  const reason = availability.reason(suite).then(value => {
    resolved = true
    return value
  })
  await began
  expect(resolved).toBe(false)
  release([])
  expect(await reason).toEqual({ unavailableReason: 'architecture' })
})

it('reuses a current manual provider without requiring the catalog dependency to support this architecture', async () => {
  const base = suitePreset(),
    dependency = {
      ...base,
      id: 'dependency',
      category: 'dependency' as const,
      items: base.items.filter(row => row.kind === 'runtime-dependency').map(row => ({ ...row, name: 'catalog-only' })),
    },
    suite = { ...base, dependencies: ['dependency'] }
  const manual: RuntimeDependency = {
    name: 'manual',
    prepareCommand: 'install',
    pathDirectories: ['bin'],
    source: 'manual',
    stage: 'ready',
    current: { ...runtimeVersion('a'), commands: ['suite-cli'], commandPaths: { 'suite-cli': 'bin/suite-cli' } },
    updatedAt: 0,
    log: '',
    checks: [],
  }
  const availability = new SuiteAvailability(
    () => [suite, dependency],
    async () => [],
    {
      manualProviders: async () => [manual],
      commandOwners: async () => [],
    },
    item => item.kind !== 'runtime-dependency' || item.name !== 'catalog-only',
  )
  const plan = await availability.plan(suite)
  expect(plan.manual).toEqual([{ id: 'dependency', name: 'manual' }])
  expect(plan.install).toEqual([])
  expect(await availability.reason(suite, plan)).toEqual({})
})

it('reads current shared installation rows asynchronously for each availability plan', async () => {
  const base = suitePreset(),
    dependency = { ...base, id: 'dependency', category: 'dependency' as const, items: base.items.filter(row => row.kind === 'runtime-dependency') },
    suite = { ...base, dependencies: [dependency.id] }
  let installs: readonly SuiteInstallRecord[] = []
  const availability = new SuiteAvailability(
    () => [suite, dependency],
    async () => structuredClone(installs),
    { manualProviders: async () => [], commandOwners: async () => [] },
    () => true,
  )
  expect((await availability.plan(suite)).install.map(row => row.entry.id)).toEqual(['dependency'])
  installs = [{ id: dependency.id, version: dependency.version, status: 'installed', entries: [], updatedAt: 1, log: '' }]
  expect((await availability.plan(suite)).reuse).toEqual(['dependency'])
  installs = [{ ...installs[0]!, status: 'installing' }]
  expect((await availability.plan(suite)).busy).toBe(true)
})

it('requires exact locked shared bytes and never substitutes a manual provider for a pinned path binding', async () => {
  const base = suitePreset()
  const pin = { dependency: 'shared-assets', version: '1.0.0', contentHash: 'a'.repeat(64), name: 'ASSETS_ROOT', path: 'assets' }
  const dependency = {
    ...base,
    category: 'dependency' as const,
    id: pin.dependency,
    version: pin.version,
    contentHash: pin.contentHash,
    locked: true as const,
    items: base.items.filter(row => row.kind === 'runtime-dependency').map(row => ({ ...row, resourceFiles: [{ path: 'assets/marker.json' }] })),
  }
  const plugin = {
    ...base,
    category: 'plugin' as const,
    identity: base.title,
    dependencies: [pin.dependency],
    items: [
      {
        kind: 'plugin' as const,
        packageName: 'fixture-plugin',
        version: '1.0.0',
        integrity: 'sha512-fixture',
        runtimeDependencies: [],
        catalogDependencies: [pin.dependency],
        access: { environment: [], entriesYaml: '' },
        resourceBindings: [pin],
      },
    ],
  }
  let installs: readonly SuiteInstallRecord[] = []
  const availability = new SuiteAvailability(
    () => [plugin, dependency],
    async () => installs,
    {
      manualProviders: async () => {
        throw new Error('must not query manual providers')
      },
      commandOwners: async () => [],
    },
    () => true,
  )
  expect((await availability.plan(plugin)).install.map(row => row.entry.id)).toEqual([pin.dependency])
  installs = [
    { id: dependency.id, version: dependency.version, contentHash: 'b'.repeat(64), locked: true, status: 'installed', entries: [], updatedAt: 1, log: '' },
  ]
  expect(await availability.reason(plugin)).toEqual({ unavailableReason: 'dependency-missing' })
  installs = [{ ...installs[0]!, contentHash: pin.contentHash }]
  expect((await availability.plan(plugin)).reuse).toEqual([pin.dependency])
  const unpinned = { ...plugin, items: plugin.items.map(item => ({ ...item, resourceBindings: [] })) }
  const { locked, ...downgraded } = dependency
  void locked
  const replaced = new SuiteAvailability(
    () => [unpinned, { ...downgraded, contentHash: 'b'.repeat(64), unavailableReason: 'invalid-entry' }],
    async () => installs,
    { manualProviders: async () => [], commandOwners: async () => [] },
    () => true,
  )
  expect(await replaced.reason(unpinned)).toEqual({ unavailableReason: 'dependency-missing' })
})
