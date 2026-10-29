import { expect, it } from 'vitest'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'
import { PluginLibrary } from '../src/use-cases/plugin-library.js'

it('adds a fixed npm version once, exposes progress and publishes only the prepared metadata', async () => {
  const rows = new Map<string, LibraryPlugin>()
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let finish!: () => void
  const ready = new Promise<void>(resolve => {
    finish = resolve
  })
  let calls = 0
  const service = new PluginLibrary(
    { get: async () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) },
    {
      list: async () => [...rows.values()],
      remove: async (name: string) => {
        rows.delete(name)
      },
      save: async row => {
        rows.set(row.packageName, row)
      },
    },
    {
      prepare: async (input, progress) => {
        calls++
        await progress('downloading')
        await ready
        await progress('prechecking')
        return {
          ...input,
          integrity: `sha512-${'A'.repeat(86)}==`,
          artifact: 'artifacts/test',
          runtimeRevision: 'revision',
          title: 'Useful plugin',
          description: 'Package description',
          bundlePatch: '[{"insert":[]}]',
          dependencies: {},
        }
      },
    },
  )
  await expect(service.add(actor, { packageName: 'example-plugin', version: 'latest' })).rejects.toThrow(
    expect.objectContaining({ code: 'plugin-identity-invalid' }),
  )
  const first = await service.add(actor, { packageName: 'example-plugin', version: '1.2.3' })
  expect(first.currentVersion).toBeNull()
  await service.add(actor, { packageName: 'example-plugin', version: '1.2.3' })
  expect((await service.list(actor))[0]?.stage).toBe('downloading')
  await expect(service.add(actor, { packageName: 'example-plugin', version: '1.2.4' })).rejects.toThrow(expect.objectContaining({ code: 'plugin-name-in-use' }))
  finish()
  await service.drain()
  expect(calls).toBe(1)
  expect(await service.list(actor)).toEqual([
    expect.objectContaining({
      packageName: 'example-plugin',
      currentVersion: '1.2.3',
      title: 'Useful plugin',
      description: 'Package description',
      stage: 'available',
      published: false,
    }),
  ])
  expect(JSON.stringify(await service.list(actor))).not.toContain('artifacts/test')
  await service.stop()
})

it('retains failed additions for explicit retry and rechecks the admitted administrator', async () => {
  const rows = new Map<string, LibraryPlugin>()
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let admin = true
  let attempts = 0
  const store = {
    list: async () => [...rows.values()],
    remove: async (name: string) => {
      rows.delete(name)
    },
    save: async (row: LibraryPlugin) => {
      rows.set(row.packageName, row)
    },
  }
  const accounts = { get: async () => ({ ...actor, admin, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }
  const service = new PluginLibrary(accounts, store, {
    prepare: async () => {
      attempts++
      throw new Error('fixture failure with private path')
    },
  })
  await service.add(actor, { packageName: '@example/tool', version: '1.0.0-beta.1' })
  await service.drain()
  expect((await service.list(actor))[0]).toMatchObject({ stage: 'failed', currentVersion: null, published: false, failureCode: 'plugin-precheck-failed' })
  expect(JSON.stringify(await service.list(actor))).not.toContain('private path')
  await service.add(actor, { packageName: '@example/tool', version: '1.0.0-beta.1' })
  await service.drain()
  expect(attempts).toBe(1)
  await service.add(actor, { packageName: '@example/tool', version: '1.0.0-beta.1' }, true)
  await service.drain()
  expect(attempts).toBe(2)
  admin = false
  await expect(service.list(actor)).rejects.toThrow(expect.objectContaining({ code: 'admin-required' }))
  await expect(service.add(actor, { packageName: 'other', version: '1.0.0' })).rejects.toThrow(expect.objectContaining({ code: 'admin-required' }))
  admin = true
  await expect(service.list({ ...actor, sessionEpoch: 1 })).rejects.toThrow(expect.objectContaining({ code: 'sign-in-required' }))
  await service.stop()
  await expect(service.add(actor, { packageName: 'other', version: '1.0.0' })).rejects.toThrow(expect.objectContaining({ code: 'plugin-job-interrupted' }))
  await store.save({ packageName: 'interrupted', version: '1.0.0', stage: 'installing', current: null, published: false })
  const restarted = new PluginLibrary(accounts, store, {
    prepare: async () => {
      throw new Error('not invoked')
    },
  })
  await restarted.recover()
  expect((await restarted.list(actor)).find(row => row.packageName === 'interrupted')).toMatchObject({ stage: 'failed', failureCode: 'plugin-job-interrupted' })
  await restarted.stop()
})

it('waits for cancellation before shutdown and never exposes a stopped job as available', async () => {
  let row: LibraryPlugin | undefined
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let cancelled = false
  const service = new PluginLibrary(
    { get: async () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) },
    {
      list: async () => (row ? [row] : []),
      remove: async () => {
        row = undefined
      },
      save: async next => {
        row = next
      },
    },
    {
      prepare: async (_input, _progress, signal) => {
        await new Promise<void>((_, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              cancelled = true
              reject(signal.reason)
            },
            { once: true },
          ),
        )
        throw new Error('unreachable')
      },
    },
  )
  await service.add(actor, { packageName: 'plugin', version: '1.0.0' })
  await service.stop()
  expect(cancelled).toBe(true)
  expect((await service.list(actor))[0]).toMatchObject({ stage: 'failed', currentVersion: null, failureCode: 'plugin-job-interrupted' })
})

it('rejects non-registry dependencies even when a peer repeats the same package name', async () => {
  let row: LibraryPlugin | undefined
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const service = new PluginLibrary(
    { get: async () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) },
    {
      list: async () => (row ? [row] : []),
      remove: async () => {
        row = undefined
      },
      save: async next => {
        row = next
      },
    },
    {
      prepare: async input => ({
        ...input,
        integrity: 'sha512-fixture',
        runtimeRevision: 'fixture',
        artifact: 'artifacts/fixture',
        title: 'Example',
        description: '',
        bundlePatch: '[]',
        dependencies: { hidden: 'https://example.test/hidden.tgz' },
        peerDependencies: { hidden: '*' },
      }),
    },
  )
  await service.add(actor, { packageName: 'plugin', version: '1.0.0' })
  await service.drain()
  expect((await service.list(actor))[0]).toMatchObject({ stage: 'failed', currentVersion: null, failureCode: 'plugin-dependency-invalid' })
  await service.stop()
})

it('waits for every preparation to settle even when recording another failure is impossible', async () => {
  const rows = new Map<string, LibraryPlugin>()
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let finishCleanup!: () => void
  let cleanupStarted!: () => void
  const started = new Promise<void>(resolve => {
    cleanupStarted = resolve
  })
  const cleanup = new Promise<void>(resolve => {
    finishCleanup = resolve
  })
  const service = new PluginLibrary(
    { get: async () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) },
    {
      list: async () => [...rows.values()],
      remove: async (name: string) => {
        rows.delete(name)
      },
      save: async next => {
        if (next.packageName === 'broken' && next.stage === 'failed') throw new Error('Disk full')
        rows.set(next.packageName, next)
      },
    },
    {
      prepare: async (input, _progress, signal) => {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        if (input.packageName === 'slow') {
          cleanupStarted()
          await cleanup
        }
        throw new Error('Cancelled')
      },
    },
  )
  await service.add(actor, { packageName: 'broken', version: '1.0.0' })
  await service.add(actor, { packageName: 'slow', version: '1.0.0' })
  let stopped = false
  const stopping = service.stop().finally(() => {
    stopped = true
  })
  const assertion = expect(stopping).rejects.toThrow('Plugin preparation tasks failed')
  await started
  await new Promise(resolve => setImmediate(resolve))
  expect(stopped).toBe(false)
  finishCleanup()
  await assertion
})

it('adds uploaded packages idempotently by content and rejects changed bytes at the same version', async () => {
  const rows = new Map<string, LibraryPlugin>()
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const discarded: string[] = []
  let serial = 0
  let integrity = 'sha512-original'
  let calls = 0
  const service = new PluginLibrary(
    { get: async () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) },
    {
      list: async () => [...rows.values()],
      remove: async (name: string) => {
        rows.delete(name)
      },
      save: async next => {
        rows.set(next.packageName, next)
      },
    },
    {
      prepare: async input => {
        calls++
        return {
          ...input,
          integrity: 'sha512-original',
          runtimeRevision: 'fixture',
          artifact: 'artifacts/original',
          title: 'Private plugin',
          description: 'Private',
          bundlePatch: '[]',
          dependencies: {},
        }
      },
    },
    {
      accept: async () => ({ packageName: '@example/private', version: '1.0.0', archive: `archive-${++serial}`, integrity }),
      discard: async archive => {
        discarded.push(archive)
      },
    },
  )
  async function* bytes() {
    yield new Uint8Array([1, 2, 3])
  }
  await service.upload(actor, 'private.tgz', bytes(), new AbortController().signal)
  await service.drain()
  expect((await service.list(actor))[0]).toMatchObject({ source: 'upload', currentVersion: '1.0.0', stage: 'available' })
  await service.upload(actor, 'same.tgz', bytes(), new AbortController().signal)
  expect(calls).toBe(1)
  expect(discarded).toEqual(['archive-2'])
  integrity = 'sha512-changed'
  await expect(service.upload(actor, 'changed.tgz', bytes(), new AbortController().signal)).rejects.toMatchObject({ code: 'plugin-version-conflict' })
  expect(discarded).toEqual(['archive-2', 'archive-3'])
  expect((await service.list(actor))[0]).toMatchObject({ currentVersion: '1.0.0', integrity: 'sha512-original' })
  await service.stop()
})

it('recovers containers before reconciling uploaded originals with durable library references', async () => {
  const events: string[] = []
  const row: LibraryPlugin = {
    packageName: 'private-plugin',
    version: '1.0.0',
    stage: 'installing',
    current: null,
    published: false,
    upload: { archive: 'archives/retained.tgz', integrity: 'sha512-fixture' },
  }
  const service = new PluginLibrary(
    { get: async () => undefined },
    { list: async () => [row], remove: async () => {}, save: async () => {} },
    {
      prepare: async () => {
        throw new Error('not invoked')
      },
      recover: async () => {
        events.push('containers')
      },
    },
    {
      accept: async () => {
        throw new Error('not invoked')
      },
      discard: async () => {},
      recover: async retained => {
        events.push('archives')
        expect(retained).toEqual(['archives/retained.tgz'])
      },
    },
  )
  await service.recover()
  expect(events).toEqual(['containers', 'archives'])
})

it('prechecks a replacement without changing the current version and confirms fresh impact before selection or removal', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const prepared = (version: string) => ({
    packageName: 'plugin',
    version,
    integrity: `sha512-${version}`,
    artifact: 'artifacts/test',
    runtimeRevision: 'revision',
    title: 'Plugin',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  })
  let row: LibraryPlugin | undefined = { packageName: 'plugin', version: '1.0.0', current: prepared('1.0.0'), stage: 'available', published: true }
  let complete!: () => void
  let gate = new Promise<void>(resolve => {
    complete = resolve
  })
  let fail = false
  let members = 2
  let revoked = false
  const service = new PluginLibrary(
    { get: async () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) },
    {
      list: async () => (row ? [row] : []),
      save: async next => {
        row = next
      },
      remove: async () => {
        row = undefined
      },
    },
    {
      prepare: async input => {
        await gate
        if (fail) throw Error('Not compatible')
        return prepared(input.version)
      },
    },
    undefined,
    {
      impact: async () => ({ groups: 2, members }),
      revoke: async () => {
        revoked = true
      },
    },
  )
  await service.replace(actor, { packageName: 'plugin', version: '2.0.0' })
  expect(row).toMatchObject({ stage: 'available', current: { version: '1.0.0' }, published: true })
  await expect(service.select(actor, 'plugin', (await service.impact(actor, 'plugin')).revision)).rejects.toThrow(
    expect.objectContaining({ code: 'plugin-candidate-unavailable' }),
  )
  complete()
  await service.drain()
  const impact = await service.impact(actor, 'plugin')
  expect(impact).toMatchObject({ groups: 2, members: 2 })
  members = 3
  await expect(service.select(actor, 'plugin', impact.revision)).rejects.toThrow(expect.objectContaining({ code: 'plugin-impact-changed' }))
  await service.select(actor, 'plugin', (await service.impact(actor, 'plugin')).revision)
  expect(row).toMatchObject({ version: '2.0.0', current: { version: '2.0.0' }, published: true })
  expect(row?.replacement).toBeUndefined()
  fail = true
  gate = Promise.resolve()
  await service.replace(actor, { packageName: 'plugin', version: '3.0.0' })
  await service.drain()
  expect(row).toMatchObject({ current: { version: '2.0.0' }, replacement: { stage: 'failed' }, published: true })
  await expect(service.select(actor, 'plugin', (await service.impact(actor, 'plugin')).revision)).rejects.toThrow(
    expect.objectContaining({ code: 'plugin-candidate-unavailable' }),
  )
  await service.remove(actor, 'plugin', (await service.impact(actor, 'plugin')).revision)
  expect(row).toBeUndefined()
  expect(revoked).toBe(true)
  await service.stop()
})

it('prepares a private uploaded replacement while retaining both archive references until selection', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const prepared = {
    packageName: 'private',
    version: '1.0.0',
    integrity: 'sha512-old',
    artifact: 'artifacts/old',
    runtimeRevision: 'revision',
    title: 'Private',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  let row: LibraryPlugin = {
    ...prepared,
    upload: { archive: 'old.tgz', integrity: prepared.integrity },
    current: prepared,
    stage: 'available',
    published: true,
  }
  let retained: readonly string[] = []
  const service = new PluginLibrary(
    { get: async () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) },
    {
      list: async () => [row],
      save: async value => {
        row = value
      },
      remove: async () => {},
    },
    { prepare: async input => ({ ...prepared, version: input.version, integrity: input.upload!.integrity }) },
    {
      accept: async () => ({ packageName: 'private', version: '2.0.0', archive: 'new.tgz', integrity: 'sha512-new' }),
      discard: async () => {
        throw Error('Accepted archive must remain referenced')
      },
      recover: async paths => {
        retained = paths
      },
    },
    { impact: async () => ({ groups: 1, members: 1 }), revoke: async () => {} },
  )
  async function* bytes() {
    yield new Uint8Array([1])
  }
  await service.upload(actor, 'new.tgz', bytes(), new AbortController().signal, 'private')
  await service.drain()
  expect(row).toMatchObject({ current: { version: '1.0.0' }, replacement: { version: '2.0.0', upload: { archive: 'new.tgz' }, stage: 'available' } })
  await service.recover()
  expect(retained).toEqual(['old.tgz', 'new.tgz'])
  await service.select(actor, 'private', (await service.impact(actor, 'private')).revision)
  expect(row).toMatchObject({ current: { version: '2.0.0' }, upload: { archive: 'new.tgz' }, published: true })
  await service.stop()
})

it('uses one transaction boundary for plugin removal and leaves the visible row on failure', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let row: LibraryPlugin | undefined = { packageName: 'plugin', version: '1.0.0', stage: 'failed', current: null, published: true }
  const store = {
    list: async () => (row ? [row] : []),
    save: async (value: LibraryPlugin) => {
      row = value
    },
    remove: async () => {
      row = undefined
    },
  }
  const accounts = { get: async () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }
  let fail = true,
    transactions = 0
  const service = new PluginLibrary(
    accounts,
    store,
    {
      prepare: async () => {
        throw Error('unused')
      },
    },
    undefined,
    {
      impact: async () => ({ groups: 2, members: 3 }),
      revoke: async () => {
        throw Error('must use transaction')
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    {
      run: async operation => {
        transactions++
        if (fail) throw Error('injected failure')
        return operation({ library: store })
      },
    },
  )
  await expect(service.remove(actor, 'plugin', (await service.impact(actor, 'plugin')).revision)).rejects.toThrow('injected failure')
  expect(row).toMatchObject({ published: true })
  expect(row?.removing).toBeUndefined()
  fail = false
  await service.remove(actor, 'plugin', (await service.impact(actor, 'plugin')).revision)
  expect(row).toBeUndefined()
  expect(transactions).toBe(2)
})

it('rejects changed bytes for failed, candidate and previously selected upload versions', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let row: LibraryPlugin = {
    packageName: 'private',
    version: '1.0.0',
    upload: { archive: 'old', integrity: 'sha512-old' },
    stage: 'failed',
    current: null,
    published: false,
  }
  let version = '1.0.0'
  let integrity = 'sha512-changed'
  let discarded = 0
  const service = new PluginLibrary(
    { get: async () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) },
    {
      list: async () => [row],
      save: async value => {
        row = value
      },
      remove: async () => {},
    },
    {
      prepare: async input => ({
        packageName: input.packageName,
        version: input.version,
        integrity: input.upload!.integrity,
        artifact: 'artifacts/test',
        runtimeRevision: 'revision',
        title: 'Private',
        description: '',
        bundlePatch: '[]',
        dependencies: {},
      }),
    },
    {
      accept: async () => ({ packageName: 'private', version, integrity, archive: integrity }),
      discard: async () => {
        discarded++
      },
    },
    { impact: async () => ({ groups: 1, members: 1 }), revoke: async () => {} },
  )
  async function* bytes() {
    yield new Uint8Array([1])
  }
  const upload = () => service.upload(actor, 'candidate.tgz', bytes(), new AbortController().signal, 'private')
  await expect(upload()).rejects.toMatchObject({ code: 'plugin-version-conflict' })
  version = '2.0.0'
  integrity = 'sha512-new'
  await upload()
  await service.drain()
  integrity = 'sha512-different'
  await expect(upload()).rejects.toMatchObject({ code: 'plugin-version-conflict' })
  await service.select(actor, 'private', (await service.impact(actor, 'private')).revision)
  version = '1.0.0'
  await expect(upload()).rejects.toMatchObject({ code: 'plugin-version-conflict' })
  expect(discarded).toBe(3)
  expect(row.current?.version).toBe('2.0.0')
  await service.stop()
})

it.each(['add', 'replace'] as const)('serializes concurrent %s calls for one package before registering preparation', async operation => {
  const rows = new Map<string, LibraryPlugin>(),
    actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  let release!: () => void,
    calls = 0
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const service = new PluginLibrary(
    { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    {
      list: async () => [...rows.values()],
      save: async row => {
        rows.set(row.packageName, row)
      },
      remove: async name => {
        rows.delete(name)
      },
    },
    {
      prepare: async input => {
        calls++
        await gate
        return {
          ...input,
          integrity: 'hash',
          artifact: 'artifact',
          runtimeRevision: 'revision',
          title: '',
          description: '',
          bundlePatch: '[]',
          dependencies: {},
        }
      },
    },
  )
  if (operation === 'replace') rows.set('example', { packageName: 'example', version: '0.9.0', current: null, stage: 'failed', published: false })
  try {
    const results = await Promise.allSettled([
      service[operation](actor, { packageName: 'example', version: '1.0.0' }),
      service[operation](actor, { packageName: 'example', version: '1.0.1' }),
    ])
    expect(results.map(row => row.status)).toEqual(['fulfilled', 'rejected'])
    expect(results[1]).toMatchObject({ reason: { code: operation === 'add' ? 'plugin-name-in-use' : 'plugin-job-busy' } })
    expect(calls).toBe(1)
  } finally {
    release()
    await service.drain()
    await service.stop()
  }
})
