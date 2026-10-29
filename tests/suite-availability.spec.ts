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
