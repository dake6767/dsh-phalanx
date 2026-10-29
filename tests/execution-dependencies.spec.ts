import { expect, it } from 'vitest'
import type { ExecutionConfiguration } from '../src/domain/platform-execution.js'
import { ExecutionDependencies } from '../src/use-cases/execution-dependencies.js'

it('holds a source version for an admitted call while its skill changes and shutdown waits for that call', async () => {
  let version = 'source-one',
    release!: () => void,
    stopped = false
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const configuration = { enabled: true, commands: [{ command: 'run', blocked: [] }], variables: [] }
  const service = new ExecutionDependencies(
    { identities: () => ['skill:reports'], get: id => ({ id, version }), owns: async () => true },
    { get: async () => configuration, list: async () => [{ owner: 'skill:reports', configuration }], save: async () => {}, remove: async () => {} },
    {
      state: () => ({ stage: 'ready', updatedAt: 0, log: '' }),
      ready: () => [],
      withPrepared: async (_, run) => run([]),
    },
  )
  let entered!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const call = service.withPrepared('skill:reports', async material => {
    expect(material.version).toBe('source-one')
    entered()
    await gate
  })
  await started
  version = 'source-two'
  await service.changed()
  expect(service.sourceVersions()).toEqual(['source-one'])
  const stopping = service.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  release()
  await call
  await stopping
  expect(service.sourceVersions()).toEqual([])
  await expect(service.withPrepared('skill:reports', async () => {})).rejects.toMatchObject({ code: 'internal' })
})

it('requires current contribution approval before leasing dependencies and removes deleted owner configurations', async () => {
  let configuration: ExecutionConfiguration = { enabled: true, commands: [{ command: 'run', blocked: [] }], variables: [], awaitingPreparation: true }
  let exists = true,
    calls = 0,
    removed = false
  const service = new ExecutionDependencies(
    {
      identities: () => (exists ? ['skill:reports'] : []),
      get: id => (exists ? { id, version: 'source', preparationApproval: 'receipt' } : undefined),
      owns: async () => exists,
    },
    {
      get: async () => (removed ? undefined : configuration),
      list: async () => (removed ? [] : [{ owner: 'skill:reports', configuration }]),
      save: async () => {},
      remove: async () => {
        removed = true
      },
    },
    {
      state: () => ({ stage: 'ready', updatedAt: 0, log: '' }),
      ready: () => [],
      withPrepared: async (_, run) => {
        calls++
        return run([])
      },
    },
  )
  try {
    await expect(service.withPrepared('skill:reports', async () => {})).rejects.toMatchObject({ code: 'not-ready' })
    configuration = { ...configuration, awaitingPreparation: false }
    await expect(service.withPrepared('skill:reports', async () => {})).rejects.toMatchObject({ code: 'not-ready' })
    expect(calls).toBe(0)
    configuration = { ...configuration, approvedContribution: 'receipt' }
    await service.withPrepared('skill:reports', async material => {
      expect(material).toEqual({ version: 'source', dependencies: [] })
    })
    expect(calls).toBe(1)
    exists = false
    await service.changed()
    expect(removed).toBe(true)
    await expect(service.withPrepared('skill:reports', async () => {})).rejects.toMatchObject({ code: 'not-ready' })
  } finally {
    await service.stop()
  }
})
