import { expect, it, vi } from 'vitest'
import { PlatformDatabaseError } from '../src/domain/platform-database.js'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import type { RuntimeDependency, RuntimeDependencyVersion, RuntimeDependencyReference } from '../src/domain/runtime-dependency.js'
import { RuntimeDependencyPreparationFailure } from '../src/domain/runtime-dependency.js'

const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
const input = { name: 'office', prepareCommand: 'install-pinned', pathDirectories: ['bin'], checkCommand: 'office --version' }
function fixture(changed: () => Promise<void> = async () => {}) {
  const rows = new Map<string, RuntimeDependency>()
  let revision = 0
  let administrator = true,
    calls = 0,
    failure = false,
    image = 'image-one'
  let gate = Promise.resolve()
  const waiters: { count: number; resolve: () => void }[] = []
  const collected: string[][] = []
  const references: RuntimeDependencyReference[] = []
  const service = new RuntimeDependencies(
    { get: async () => ({ ...actor, admin: administrator, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    {
      view: { list: () => structuredClone([...rows.values()]), version: () => String(revision) },
      list: async () => structuredClone([...rows.values()]),
      save: async row => {
        revision++
        rows.set(row.name, structuredClone(row))
        if (row.stage === 'ready') for (const waiter of waiters) if (row.current?.id === `version-${waiter.count}`) waiter.resolve()
      },
      remove: async name => {
        revision++
        rows.delete(name)
      },
    },
    {
      isolated: true,
      recover: async () => {},
      identity: definition => definition.prepareCommand + (definition.checkCommand ?? '') + image,
      collect: async retained => {
        collected.push([...retained])
      },
      prepare: async (definition, log) => {
        calls++
        await gate
        await log('complete preparation output\n')
        if (failure) throw new RuntimeDependencyPreparationFailure('check-failed', 'check exited 1')
        return {
          id: `version-${calls}`,
          identity: definition.prepareCommand + (definition.checkCommand ?? '') + image,
          directory: '/private/artifact',
          mountedPath: '/fixed/artifact',
          commands: definition.type === 'python-library' ? ['python3'] : definition.type === 'resource' ? [] : ['office'],
          commandPaths: definition.type === 'python-library' ? { python3: 'venv/bin/python3' } : definition.type === 'resource' ? {} : { office: 'bin/office' },
          ...(definition.type === 'python-library'
            ? { python: { name: definition.name, interpreter: 'venv/bin/python3', sitePackages: 'venv/lib/python3.11/site-packages', abi: 'cpython-311' } }
            : {}),
          pathDirectories: definition.pathDirectories,
          bytes: 42,
          isolated: true,
          checks: [{ kind: 'check-command', passed: true }],
          log: 'complete preparation output\n',
        } satisfies RuntimeDependencyVersion
      },
    },
    { now: () => 100 },
    { list: async () => references },
    changed,
  )
  return {
    service,
    rows,
    references,
    collected,
    ready(count: number) {
      return [...rows.values()].some(row => row.stage === 'ready' && row.current?.id === `version-${count}`)
        ? Promise.resolve()
        : new Promise<void>(resolve => {
            waiters.push({ count, resolve })
          })
    },
    image(value: string) {
      image = value
    },
    hold() {
      let release!: () => void
      gate = new Promise<void>(resolve => {
        release = resolve
      })
      return release
    },
    get calls() {
      return calls
    },
    fail() {
      failure = true
    },
    demote() {
      administrator = false
    },
  }
}

it('creates a credential-free dependency, preserves complete logs, and rejects non-admin access and secret inputs', async () => {
  const f = fixture()
  await f.service.create(actor, input)
  await f.service.prepare(actor, 'office')
  expect(f.calls).toBe(1)
  expect(await f.service.view(actor, 'office')).toMatchObject({ stage: 'ready', current: { bytes: 42 }, log: 'complete preparation output\n' })
  await expect(f.service.create(actor, input)).rejects.toThrow(expect.objectContaining({ code: 'runtime-dependency-name-conflict' }))
  await expect(f.service.create(actor, { ...input, name: 'bad', variables: [{ name: 'KEY', secret: true, value: 'private' }] } as never)).rejects.toThrow(
    expect.objectContaining({ code: 'runtime-dependency-invalid' }),
  )
  expect([...f.rows.keys()]).toEqual(['office'])
  f.demote()
  await expect(f.service.list(actor)).rejects.toThrow(expect.objectContaining({ code: 'admin-required' }))
})

it('rejects a second dependency exposing the same command and retains failed entries for retry', async () => {
  const f = fixture()
  await f.service.create(actor, input)
  await f.service.prepare(actor, 'office')
  await f.service.create(actor, { ...input, name: 'other' })
  await f.service.prepare(actor, 'other')
  expect(await f.service.view(actor, 'other')).toMatchObject({ stage: 'failed', failureCode: 'command-conflict' })
  expect((await f.service.view(actor, 'other')).log).toContain('office')
  expect((await f.service.view(actor, 'office')).stage).toBe('ready')
})

it('blocks referenced deletion with reference details and keeps the usable version when a manual preparation fails', async () => {
  const f = fixture()
  await f.service.create(actor, input)
  await f.service.prepare(actor, 'office')
  f.references.push({ kind: 'skill', name: 'reports' })
  await expect(f.service.remove(actor, 'office')).rejects.toMatchObject({ code: 'runtime-dependency-referenced' })
  expect((await f.service.view(actor, 'office')).references).toEqual(f.references)
  f.fail()
  await f.service.prepare(actor, 'office')
  expect(await f.service.view(actor, 'office')).toMatchObject({ stage: 'failed', failureCode: 'check-failed', current: { id: 'version-1' } })
  f.references.length = 0
  await f.service.remove(actor, 'office')
  expect(await f.service.list(actor)).toEqual([])
})

it('keeps the old selection while a candidate prepares, then retains the previous version and any active leases', async () => {
  const f = fixture()
  await f.service.create(actor, input)
  await f.service.prepare(actor, 'office')
  let releaseCall!: () => void
  const call = f.service.withPrepared(['office'], async versions => {
    expect(versions[0]?.id).toBe('version-1')
    await new Promise<void>(resolve => {
      releaseCall = resolve
    })
  })
  const releasePreparation = f.hold()
  await f.service.update(actor, 'office', { ...input, prepareCommand: 'new-command' })
  expect(f.service.ready(['office'])[0]?.id).toBe('version-1')
  releasePreparation()
  await f.service.prepare(actor, 'office')
  expect(f.service.ready(['office'])[0]?.id).toBe('version-2')
  await f.service.prepare(actor, 'office')
  expect(f.rows.get('office')?.previous?.id).toBe('version-2')
  expect(f.collected.at(-1)).toContain('version-1')
  releaseCall()
  await call
  expect(f.collected.at(-1)).not.toContain('version-1')
  expect(f.collected.at(-1)).toEqual(expect.arrayContaining(['version-2', 'version-3']))
})

it('prepares after image identity changes, preserves interrupted records for retry, and locks catalog definitions', async () => {
  const f = fixture()
  await f.service.create(actor, input)
  await f.service.prepare(actor, 'office')
  await f.service.start()
  expect(f.calls).toBe(1)
  f.image('image-two')
  await f.service.recover()
  const releaseImage = f.hold()
  await f.service.start()
  const preparingImage = f.service.prepare(actor, 'office')
  await vi.waitFor(() => expect(f.calls).toBe(2))
  releaseImage()
  await preparingImage
  expect(f.calls).toBe(2)
  f.rows.set('office', { ...f.rows.get('office')!, stage: 'preparing' })
  await f.service.recover()
  expect(await f.service.view(actor, 'office')).toMatchObject({ stage: 'failed', failureCode: 'interrupted' })
  await f.service.start()
  expect(f.calls).toBe(2)
  f.rows.set('office', { ...f.rows.get('office')!, source: 'mcp-catalog' })
  await expect(f.service.update(actor, 'office', { ...input, prepareCommand: 'changed' })).rejects.toThrow(
    expect.objectContaining({ code: 'runtime-dependency-locked' }),
  )
})

it('restores the previous version if publishing a prepared replacement fails', async () => {
  let fail = false
  const published: string[] = []
  const f = fixture(async () => {
    published.push(f.service.ready(['office'])[0]!.id)
    if (fail) {
      fail = false
      throw new Error('projection unavailable')
    }
  })
  await f.service.create(actor, input)
  await f.service.prepare(actor, 'office')
  fail = true
  await f.service.prepare(actor, 'office')
  expect(await f.service.view(actor, 'office')).toMatchObject({ stage: 'failed', current: { id: 'version-1' } })
  expect(published).toEqual(['version-1', 'version-2', 'version-1', 'version-1'])
  expect(f.collected.at(-1)).toContain('version-1')
})

it('automatically prepares when the check command is removed', async () => {
  const f = fixture()
  await f.service.create(actor, input)
  await f.service.prepare(actor, 'office')
  const { checkCommand, ...withoutCheck } = input
  void checkCommand
  await f.service.update(actor, 'office', withoutCheck)
  expect((await f.service.view(actor, 'office')).stage).toBe('preparing')
  expect(f.rows.get('office')?.preparationIdentity).toBe('install-pinnedimage-one')
  await f.ready(2)
  expect(f.calls).toBe(2)
  expect(await f.service.view(actor, 'office')).not.toHaveProperty('checkCommand')
  await f.service.stop()
})

it('honors a retry requested after ready is visible while projection publication is finishing', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const f = fixture(() => gate)
  await f.service.create(actor, input)
  await f.ready(1)
  const retried = f.service.prepare(actor, 'office')
  await vi.waitFor(() => expect(f.rows.get('office')?.retryPending).toBe(true))
  expect(await f.service.view(actor, 'office')).toMatchObject({ stage: 'preparing', current: { id: 'version-1' } })
  expect((await f.service.list(actor))[0]?.stage).toBe('preparing')
  const joined = f.service.prepare(actor, 'office')
  release()
  await Promise.all([retried, joined])
  expect(f.calls).toBe(2)
  expect(await f.service.view(actor, 'office')).toMatchObject({ stage: 'ready', current: { id: 'version-2' } })
  await f.service.stop()
})

it('observes a fire-and-forget managed retry rejection when shutdown overtakes publication', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const f = fixture(() => gate)
  await f.service.create(actor, input)
  await f.ready(1)
  void f.service.restartManaged('office')
  const stopped = f.service.stop()
  release()
  await stopped
  await new Promise<void>(resolve => {
    setImmediate(resolve)
  })
  expect(f.calls).toBe(1)
})

it('cancels a queued retry when deletion overtakes publication', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const f = fixture(() => gate)
  await f.service.create(actor, input)
  await f.ready(1)
  const retry = f.service.prepare(actor, 'office')
  const rejected = expect(retry).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(f.rows.get('office')?.retryPending).toBe(true))
  const removed = f.service.remove(actor, 'office')
  release()
  await Promise.all([removed, rejected])
  expect(f.calls).toBe(1)
  expect(await f.service.list(actor)).toEqual([])
  await f.service.stop()
})

it('recovers an accepted queued retry as interrupted while retaining the usable version', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    f = fixture(() => gate)
  await f.service.create(actor, input)
  await f.ready(1)
  const retry = f.service.prepare(actor, 'office')
  await vi.waitFor(() => expect(f.rows.get('office')?.retryPending).toBe(true))
  const recovered = fixture()
  for (const [name, row] of f.rows) recovered.rows.set(name, structuredClone(row))
  try {
    await recovered.service.recover()
    await recovered.service.start()
    expect(await recovered.service.view(actor, 'office')).toMatchObject({ stage: 'failed', failureCode: 'interrupted', current: { id: 'version-1' } })
    expect(recovered.calls).toBe(0)
  } finally {
    release()
    await retry
    await f.service.stop()
    await recovered.service.stop()
  }
})

it('creates a Python library from exact PyPI pins and rejects unpinned or conflicting package declarations before preparation', async () => {
  const f = fixture()
  await f.service.create(actor, { name: 'python-documents', type: 'python-library', packages: ['PyMuPDF==2.0', 'six==1.17.0'] })
  await f.service.prepare(actor, 'python-documents')
  expect(await f.service.view(actor, 'python-documents')).toMatchObject({ type: 'python-library', packages: ['pymupdf==2.0', 'six==1.17.0'], stage: 'ready' })
  for (const packages of [['six>=1.0'], ['six==1.*'], ['six==1.0', 'SIX==2.0']]) {
    await expect(f.service.create(actor, { name: 'invalid-python', type: 'python-library', packages })).rejects.toThrow(
      expect.objectContaining({ code: 'runtime-dependency-invalid' }),
    )
  }
  expect((await f.service.list(actor)).map(row => row.name)).toEqual(['python-documents'])
})

it('allows Python libraries to share the composed interpreter but rejects an ordinary command with that name', async () => {
  const f = fixture()
  for (const name of ['python-a', 'python-b']) {
    await f.service.create(actor, { name, type: 'python-library', packages: ['six==1.17.0'] })
    await f.service.prepare(actor, name)
    expect((await f.service.view(actor, name)).stage).toBe('ready')
  }
  expect(f.service.ready(['python-a', 'python-b'])).toHaveLength(2)
  const { python, ...prepared } = f.service.ready(['python-a'])[0]!
  void python
  const regular = { ...prepared, id: 'regular' }
  await expect(f.service.commitManaged('catalog:regular', { ...input, name: 'regular' }, regular)).rejects.toMatchObject({ code: 'command-conflict' })
})

it('replaces the whole definition when switching a manual dependency from Python libraries to commands and back', async () => {
  const f = fixture(),
    python = { name: 'office', type: 'python-library' as const, packages: ['six==1.17.0'] }
  await f.service.create(actor, python)
  await f.service.prepare(actor, 'office')
  await f.service.update(actor, 'office', input)
  await f.service.prepare(actor, 'office')
  expect(await f.service.view(actor, 'office')).not.toHaveProperty('type')
  expect(await f.service.view(actor, 'office')).not.toHaveProperty('packages')
  expect(f.service.ready(['office'])[0]).not.toHaveProperty('python')
  await f.service.update(actor, 'office', python)
  await f.service.prepare(actor, 'office')
  expect(await f.service.view(actor, 'office')).toMatchObject({ type: 'python-library', packages: ['six==1.17.0'], stage: 'ready' })
})

it('prepares a resource without invented commands and clears its category when switching back to commands', async () => {
  const f = fixture(),
    resource = { name: 'office', type: 'resource' as const, prepareCommand: 'prepare-assets' }
  await f.service.create(actor, resource)
  await f.service.prepare(actor, 'office')
  expect(await f.service.view(actor, 'office')).toMatchObject({ type: 'resource', pathDirectories: [], stage: 'ready', current: { commands: [] } })
  await f.service.update(actor, 'office', input)
  await f.service.prepare(actor, 'office')
  expect(await f.service.view(actor, 'office')).not.toHaveProperty('type')
  expect((await f.service.view(actor, 'office')).current?.commands).toEqual(['office'])
  await f.service.update(actor, 'office', resource)
  await f.service.prepare(actor, 'office')
  expect(await f.service.view(actor, 'office')).toMatchObject({ type: 'resource', pathDirectories: [], current: { commands: [] } })
})

it('leases the exact frozen plan through delayed publication even after two ready switches', async () => {
  const f = fixture()
  await f.service.create(actor, input)
  await f.service.prepare(actor, 'office')
  const frozen = f.service.ready(['office'])
  let publish!: () => void
  const waiting = new Promise<void>(resolve => {
    publish = resolve
  })
  const preparation = f.service.withVersions(frozen, async versions => {
    await waiting
    expect(versions).toEqual(frozen)
  })
  try {
    await f.service.prepare(actor, 'office')
    await f.service.prepare(actor, 'office')
    expect(f.service.ready(['office'])[0]?.id).toBe('version-3')
    expect(f.collected.at(-1)).toContain('version-1')
  } finally {
    publish()
    await preparation
  }
  expect(f.collected.at(-1)).not.toContain('version-1')
})

it('keeps its committed ready version and busy lease while a publication view temporarily refreshes', async () => {
  let unavailable = true,
    entered!: () => void
  const publishing = new Promise<void>(resolve => {
    entered = resolve
  })
  const f = fixture(async () => {
    if (unavailable) {
      entered()
      throw new PlatformDatabaseError('unavailable', 'Another preparation is publishing')
    }
  })
  const release = f.hold()
  try {
    await f.service.create(actor, input)
    release()
    await publishing
    expect(f.rows.get('office')).toMatchObject({ stage: 'ready', current: { id: 'version-1' } })
    expect(f.service.preparing(['office'])).toBe(true)
    unavailable = false
    await vi.waitFor(() => expect(f.service.preparing(['office'])).toBe(false))
    expect(f.rows.get('office')).toMatchObject({ stage: 'ready', current: { id: 'version-1' } })
    expect(f.calls).toBe(1)
  } finally {
    unavailable = false
    release()
    await f.service.stop()
  }
})

it.each([false, true])('preserves committed publication facts through stop and reopen (previous=%s)', async previous => {
  let unavailable = false,
    entered!: () => void
  const publishing = new Promise<void>(resolve => {
    entered = resolve
  })
  const f = fixture(async () => {
    if (unavailable) {
      entered()
      throw new PlatformDatabaseError('unavailable', 'Another preparation is publishing')
    }
  })
  let preparing: Promise<void> | undefined, reopened: RuntimeDependencies | undefined
  try {
    if (previous) {
      await f.service.create(actor, input)
      await vi.waitFor(() => expect(f.service.preparing(['office'])).toBe(false))
    }
    unavailable = true
    if (previous) preparing = f.service.prepare(actor, 'office')
    else await f.service.create(actor, input)
    await publishing
    const committed = structuredClone(f.rows.get('office')!)
    expect(committed).toMatchObject({ stage: 'ready', current: { id: previous ? 'version-2' : 'version-1' } })
    expect(committed.previous?.id).toBe(previous ? 'version-1' : undefined)
    expect(f.service.preparing(['office'])).toBe(true)
    unavailable = false
    await f.service.stop()
    await preparing
    expect.soft(f.rows.get('office')).toEqual(committed)
    expect(f.service.preparing(['office'])).toBe(false)
    reopened = new RuntimeDependencies(
      { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }) },
      {
        view: { list: () => [...f.rows.values()], version: () => '0' },
        list: async () => [...f.rows.values()],
        save: async row => {
          f.rows.set(row.name, structuredClone(row))
        },
        remove: async name => {
          f.rows.delete(name)
        },
      },
      {
        isolated: true,
        identity: () => committed.preparationIdentity!,
        recover: async () => {},
        collect: async () => {},
        prepare: async () => {
          throw Error('A committed version must not prepare again on reopen')
        },
      },
      { now: () => 100 },
    )
    await reopened.recover()
    await reopened.start()
    expect(f.rows.get('office')).toEqual(committed)
    expect(reopened.ready(['office'])[0]?.id).toBe(committed.current!.id)
    expect(f.calls).toBe(previous ? 2 : 1)
  } finally {
    unavailable = false
    await f.service.stop()
    await preparing
    await reopened?.stop()
  }
})
