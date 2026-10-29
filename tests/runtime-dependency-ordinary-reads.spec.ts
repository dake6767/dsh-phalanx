import { expect, it, vi } from 'vitest'
import type { McpState } from '../src/domain/mcp-service.js'
import { PlatformDatabaseError } from '../src/domain/platform-database.js'
import type { RuntimeDependency } from '../src/domain/runtime-dependency.js'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import { McpRuntimeDependencies } from '../src/use-cases/mcp-runtime-dependencies.js'
import { McpServices } from '../src/use-cases/mcp-services.js'
import { asyncMcpFacts } from './fixtures/async-mcp-facts.js'
import { SkillLibrary } from '../src/use-cases/skill-library.js'
import { asyncSkillFacts } from './fixtures/async-skill-facts.js'
import { runtimeVersion } from './fixtures/runtime-version.js'

function fixture() {
  const account = {
    username: 'admin',
    spaceId: 'admin',
    groupId: 'admins',
    admin: true,
    disabled: false,
    sessionEpoch: 0,
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }
  const rows: RuntimeDependency[] = [
    {
      name: 'live',
      source: 'manual',
      prepareCommand: 'true',
      pathDirectories: ['bin'],
      stage: 'preparing',
      updatedAt: 1,
      log: 'Preparing a replacement',
      checks: [],
      current: runtimeVersion('a'),
    },
  ]
  let unavailable = true,
    readGate = Promise.resolve()
  let viewFailure: unknown
  const dependencies = new RuntimeDependencies(
    { get: async () => account },
    {
      view: {
        list: () => {
          if (viewFailure) throw viewFailure
          if (unavailable) throw new PlatformDatabaseError('unavailable', 'A committed view is refreshing')
          return rows
        },
        version: () => {
          if (viewFailure) throw viewFailure
          if (unavailable) throw new PlatformDatabaseError('unavailable', 'A committed view is refreshing')
          return '0'
        },
      },
      list: async () => {
        await readGate
        return rows
      },
      save: async () => {
        throw Error('Ordinary reads must not save facts')
      },
      remove: async () => {
        throw Error('Ordinary reads must not remove facts')
      },
    },
    {
      isolated: true,
      identity: () => '',
      prepare: async () => {
        throw Error('Ordinary reads must not prepare')
      },
      recover: async () => {},
      collect: async () => {},
    },
    { now: () => 0 },
  )
  let businessState: McpState = {
    services: [
      {
        name: 'p-live',
        generation: 1,
        description: '',
        url: '',
        run: { location: 'shared', command: 'node', args: [], env: [], runtimeDependencies: ['live'] },
      },
    ],
    grants: { admins: ['p-live'] },
  }
  const state = asyncMcpFacts({
    read: () => businessState,
    write: next => {
      businessState = next
    },
  })
  const runtime = new McpRuntimeDependencies(state, dependencies)
  const services = new McpServices(
    {
      get: async () => account,
      list: async () => [account],
      listGroups: async () => [{ id: 'admins', name: 'Admins', kind: 'admin', isDefault: false, memberCount: 1 }],
    },
    state,
    { synchronize: async () => {} },
    runtime,
  )
  return {
    account,
    rows,
    pauseRead(gate: Promise<void>) {
      readGate = gate
    },
    failView(error: unknown) {
      viewFailure = error
    },
    dependencies,
    services,
    runtime,
    allowView() {
      unavailable = false
    },
    hasService(name: string) {
      return businessState.services.some(row => row.name === name)
    },
  }
}

it('refuses runtime admission while readiness publication is unavailable', async () => {
  const f = fixture()
  expect(() => f.dependencies.ready(['live'])).toThrow(PlatformDatabaseError)
})

it('reads management preparation progress from ordinary rows without weakening admission', async () => {
  const f = fixture()
  expect(() => f.services.captureLocalPolicy()).toThrow(PlatformDatabaseError)
  await expect(f.services.list(f.account)).resolves.toMatchObject([
    { name: 'p-live', preparation: { stage: 'preparing', updatedAt: 1, log: 'Preparing a replacement' } },
  ])
})

it('previews a skill upload and retains admitted execution sources while dependency publication is unavailable', async () => {
  const f = fixture(),
    collected: string[][] = []
  const library = new SkillLibrary(
    { get: async () => f.account },
    asyncSkillFacts({
      list: () => [],
      save: async () => {
        throw Error('A preview must not save a skill')
      },
      remove: async () => {
        throw Error('A preview must not remove a skill')
      },
    }),
    {
      accept: async () => ({ name: 'uploaded-skill', description: 'Fixture', hash: 'b'.repeat(64), markdown: '# Skill', files: ['SKILL.md'] }),
      read: async () => ({ markdown: '# Skill', files: ['SKILL.md'] }),
      collect: async hashes => {
        collected.push([...hashes])
      },
      newToken: () => 'preview-token',
    },
    { now: () => 0 },
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    f.dependencies,
    { sourceVersions: () => ['a'.repeat(64)] },
  )
  async function* content() {
    yield new Uint8Array([1])
  }
  try {
    await expect(library.upload(f.account, content(), new AbortController().signal)).resolves.toMatchObject({ name: 'uploaded-skill', token: 'preview-token' })
    expect(collected.at(-1)).toEqual(expect.arrayContaining(['a'.repeat(64), 'b'.repeat(64)]))
  } finally {
    await library.stop()
  }
})

it('waits for view publication while saving a newly selected MCP dependency instead of returning a false failure', async () => {
  const f = fixture()
  let outcome = 'pending',
    failure: unknown
  const saving = f.services
    .save(
      f.account,
      {
        name: 'p-binding',
        description: 'Fixture',
        url: '',
        run: { location: 'shared', command: 'node', args: [], env: [], runtimeDependencies: ['live'] },
      },
      true,
    )
    .then(
      () => {
        outcome = 'passed'
      },
      error => {
        failure = error
        outcome = 'failed'
      },
    )
  try {
    await vi.waitFor(() => expect(failure || f.hasService('p-binding')).toBeTruthy())
    expect(failure).toBeUndefined()
    expect(outcome).toBe('pending')
    f.allowView()
    await saving
    expect(outcome).toBe('passed')
    expect((await f.services.list(f.account)).find(row => row.name === 'p-binding')?.run?.runtimeDependencies).toEqual(['live'])
  } finally {
    f.allowView()
    await saving
    await f.services.stop()
  }
})

it('validates ordinary bindings against current rows while retaining the synchronous admission fence', async () => {
  const f = fixture()
  try {
    await expect(f.dependencies.readReady(['live', 'live'])).resolves.toEqual([runtimeVersion('a')])
    expect(() => f.dependencies.ready(['live'])).toThrow(PlatformDatabaseError)
    await expect(f.dependencies.readReady(['missing'])).rejects.toMatchObject({ code: 'runtime-dependency-unavailable' })
    f.rows[0] = { ...f.rows[0]!, candidate: true }
    await expect(f.dependencies.readReady(['live'])).rejects.toThrow()
    await expect(f.dependencies.readReady(['live'], true)).resolves.toEqual([runtimeVersion('a')])
    const { current, ...withoutCurrent } = f.rows[0]!
    f.rows[0] = withoutCurrent
    await expect(f.dependencies.readReady(['live'], true)).rejects.toMatchObject({ code: 'runtime-dependency-unavailable' })
    f.rows[0] = {
      ...f.rows[0]!,
      candidate: false,
      current: { ...current!, python: { name: 'old', interpreter: 'bin/python', sitePackages: 'lib', abi: 'fixture' } },
    }
    await expect(f.dependencies.readReady(['live'])).resolves.toMatchObject([{ python: { name: 'live' } }])
  } finally {
    await f.dependencies.stop()
    await f.services.stop()
  }
})

it('refuses a binding whose ordinary read completes after shutdown', async () => {
  const f = fixture()
  let release!: () => void
  f.pauseRead(
    new Promise<void>(resolve => {
      release = resolve
    }),
  )
  const reading = f.dependencies.readReady(['live'])
  await f.dependencies.stop()
  release()
  await expect(reading).rejects.toMatchObject({ code: 'runtime-dependency-unavailable' })
  await expect(f.dependencies.readReady([])).rejects.toMatchObject({ code: 'runtime-dependency-unavailable' })
  await f.services.stop()
})

it('cancels a publication wait on stop without rolling back committed MCP settings', async () => {
  const f = fixture()
  const saving = f.services.save(
    f.account,
    { name: 'p-binding', description: '', url: '', run: { location: 'shared', command: 'node', args: [], env: [], runtimeDependencies: ['live'] } },
    true,
  )
  const result = saving.then(
    () => undefined,
    error => error,
  )
  await vi.waitFor(() => expect(f.hasService('p-binding')).toBe(true))
  await f.services.stop()
  expect(await result).toBeInstanceOf(Error)
  expect(f.hasService('p-binding')).toBe(true)
})

it('propagates unknown projection failures without retrying or rolling back committed settings', async () => {
  const f = fixture(),
    failure = new Error('Unknown projection failure')
  f.failView(failure)
  await expect(
    f.services.save(
      f.account,
      { name: 'p-binding', description: '', url: '', run: { location: 'shared', command: 'node', args: [], env: [], runtimeDependencies: ['live'] } },
      true,
    ),
  ).rejects.toBe(failure)
  expect(f.hasService('p-binding')).toBe(true)
  await f.services.stop()
})
