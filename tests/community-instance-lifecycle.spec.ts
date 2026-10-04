import { expect, it } from 'vitest'
import { CommunityInstanceLifecycle } from '../src/use-cases/community-instance-lifecycle.js'
import type { CommunityRuntimeDriverPort } from '../src/ports/community-runtime-driver.js'

it('shares one pending start and keeps another identity independent', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let pid = 100
  const active = new Set<number>()
  const driver: CommunityRuntimeDriverPort = {
    rebuild: async () => [],
    start: async (userId, _authority, _access, signal) => {
      if (userId === 'alice') await gate
      signal.throwIfAborted()
      const instance = { userId, processId: ++pid, origin: `http://127.0.0.1:${pid}`, launchUrl: `http://127.0.0.1:${pid}/launch` }
      active.add(pid); return instance
    },
    alive: async instance => active.has(instance.processId),
    stop: async instance => { active.delete(instance.processId) }, detach: async () => {},
  }
  const runtime = new CommunityInstanceLifecycle(driver, () => ({ url: 'http://127.0.0.1:3081/model', token: 'scoped-fixture' }))
  const first = runtime.ensure('alice', '127.0.0.1:3080')
  const same = runtime.ensure('alice', '127.0.0.1:3080')
  const bob = await runtime.ensure('bob', '127.0.0.1:3080')
  release()
  const alice = await first
  expect(await same).toEqual(alice)
  expect(bob.processId).not.toBe(alice.processId)
  expect(runtime.status('alice')).toEqual({ state: 'ready', instance: alice })
  await runtime.terminate('alice')
  expect(runtime.status('alice')).toEqual({ state: 'stopped' })
  expect(await runtime.ensure('bob', '127.0.0.1:3080')).toEqual(bob)
  await runtime.stopAll()
})

it('fences new admission immediately while termination waits for the owned instance', async () => {
  let release!: () => void
  const stopped = new Promise<void>(resolve => { release = resolve })
  const instance = { userId: 'alice', processId: 101, origin: 'http://127.0.0.1:4101', launchUrl: 'http://127.0.0.1:4101/launch' }
  const driver: CommunityRuntimeDriverPort = { rebuild: async () => [], start: async () => instance,
    alive: async () => true, stop: async () => { await stopped }, detach: async () => {} }
  const runtime = new CommunityInstanceLifecycle(driver, () => ({ url: 'http://127.0.0.1:3081/model', token: 'scoped-fixture' }))
  await runtime.ensure('alice', '127.0.0.1:3080')
  const termination = runtime.terminate('alice')
  try {
    expect(runtime.status('alice').state).toBe('draining')
    await expect(runtime.ensure('alice', '127.0.0.1:3080')).rejects.toMatchObject({ reason: 'draining' })
  } finally { release(); await termination }
  expect(runtime.status('alice')).toEqual({ state: 'stopped' })
})

it('keeps a busy instance fenced for activity checks and replaces a dead carrier only after cleanup succeeds', async () => {
  const instance = { userId: 'alice', processId: 101, origin: 'http://127.0.0.1:4101', launchUrl: 'http://127.0.0.1:4101/launch' }
  let alive = true; let removalAllowed = false; let pid = 100
  const driver: CommunityRuntimeDriverPort = { rebuild: async () => ['old-owned-container'], start: async () => ({ ...instance, processId: ++pid }),
    alive: async () => alive, stop: async () => { if (!removalAllowed) throw new Error('fixture removal blocked') }, detach: async () => {} }
  const runtime = new CommunityInstanceLifecycle(driver, () => ({ url: 'http://127.0.0.1:3081/model', token: 'scoped-fixture' }))
  expect(await runtime.reconcileStartupContainers()).toEqual({ adopted: [], swept: ['old-owned-container'] })
  const first = await runtime.ensure('alice', '127.0.0.1:3080')
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const reclaim = runtime.reclaim('alice', async () => { await gate; return false })
  await expect(runtime.ensure('alice', '127.0.0.1:3080')).rejects.toMatchObject({ reason: 'draining' })
  release(); expect(await reclaim).toBe('busy')
  alive = false
  await expect(runtime.ensure('alice', '127.0.0.1:3080')).rejects.toThrow('fixture removal blocked')
  expect(runtime.status('alice')).toEqual({ state: 'ready', instance: first })
  removalAllowed = true
  const replacement = await runtime.ensure('alice', '127.0.0.1:3080')
  expect(replacement.processId).not.toBe(first.processId)
  await runtime.stopAll()
})

it('waits for a cancelled pending launch to finish cleanup before termination completes', async () => {
  let admitted!: () => void; const admission = new Promise<void>(resolve => { admitted = resolve })
  const driver: CommunityRuntimeDriverPort = { rebuild: async () => [], start: async (_user, _authority, _access, signal) => {
    admitted(); await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true }) }); throw new Error('unreachable')
  }, alive: async () => true, stop: async () => {}, detach: async () => {} }
  const runtime = new CommunityInstanceLifecycle(driver, () => ({ url: 'http://127.0.0.1:3081/model', token: 'scoped-fixture' }))
  const pending = runtime.ensure('alice', '127.0.0.1:3080')
  const rejected = expect(pending).rejects.toMatchObject({ reason: 'start-cancelled' })
  await admission; await runtime.terminate('alice'); await rejected
  expect(runtime.status('alice')).toEqual({ state: 'stopped' })
  await runtime.stopAll()
})

it('closes admission after a failed launch cannot confirm resource cleanup', async () => {
  const { CommunityRuntimeCleanupError } = await import('../src/ports/community-runtime-driver.js')
  const driver: CommunityRuntimeDriverPort = { rebuild: async () => [], start: async () => { throw new CommunityRuntimeCleanupError('fixture incomplete cleanup') },
    alive: async () => false, stop: async () => {}, detach: async () => {} }
  const runtime = new CommunityInstanceLifecycle(driver, () => ({ url: 'http://127.0.0.1:3081/model', token: 'scoped-fixture' }))
  await expect(runtime.ensure('alice', '127.0.0.1:3080')).rejects.toMatchObject({ reason: 'shutdown' })
  await expect(runtime.ensure('bob', '127.0.0.1:3080')).rejects.toMatchObject({ reason: 'shutdown' })
})

it('releases every owned carrier on shutdown even when an in-flight reclamation fails', async () => {
  let reject!: (error: Error) => void
  const gate = new Promise<boolean>((_resolve, fail) => { reject = fail })
  const detached: string[] = []
  const driver: CommunityRuntimeDriverPort = { rebuild: async () => [], start: async userId => ({ userId, processId: 101,
    origin: 'http://127.0.0.1:4101', launchUrl: 'http://127.0.0.1:4101/launch' }), alive: async () => true,
    stop: async () => {}, detach: async instance => { detached.push(instance.userId) } }
  const runtime = new CommunityInstanceLifecycle(driver, () => ({ url: 'http://127.0.0.1:3081/model', token: 'scoped-fixture' }))
  await runtime.ensure('alice', '127.0.0.1:3080'); await runtime.ensure('bob', '127.0.0.1:3080')
  const reclaim = runtime.reclaim('alice', async () => await gate)
  const reclaimFailure = expect(reclaim).rejects.toThrow('fixture activity failed')
  const stop = runtime.stopAll()
  const stopFailure = expect(stop).rejects.toThrow()
  reject(new Error('fixture activity failed'))
  await reclaimFailure; await stopFailure
  expect(detached.sort()).toEqual(['alice', 'bob'])
  await expect(runtime.ensure('bob', '127.0.0.1:3080')).rejects.toMatchObject({ reason: 'shutdown' })
})

it('fences entry across restart and serializes termination with replacement without touching a peer', async () => {
  let pid = 100; let release!: () => void
  let reached!: () => void; const stopping = new Promise<void>(resolve => { reached = resolve })
  const gate = new Promise<void>(resolve => { release = resolve }); const active = new Set<number>()
  const driver: CommunityRuntimeDriverPort = { rebuild: async () => [], start: async userId => {
    const instance = { userId, processId: ++pid, origin: `http://127.0.0.1:${pid}`, launchUrl: `http://127.0.0.1:${pid}/launch` }; active.add(pid); return instance
  }, alive: async instance => active.has(instance.processId), stop: async instance => { if (instance.userId === 'alice') { reached(); await gate }; active.delete(instance.processId) }, detach: async () => {} }
  const runtime = new CommunityInstanceLifecycle(driver, () => ({ url: 'http://127.0.0.1:3081/model', token: 'scoped-fixture' }))
  const alice = await runtime.ensure('alice', 'https://community.example/'); const bob = await runtime.ensure('bob', 'https://community.example/')
  const restarted = runtime.restart('alice', 'https://community.example/'); await stopping
  await expect(runtime.ensure('alice', 'https://community.example/')).rejects.toMatchObject({ reason: 'draining' })
  expect(await runtime.ensure('bob', 'https://community.example/')).toEqual(bob)
  const terminated = runtime.terminate('alice'); release()
  expect((await restarted).processId).not.toBe(alice.processId)
  await terminated; expect(runtime.status('alice').state).toBe('stopped'); expect(active).toEqual(new Set([bob.processId]))
  await runtime.stopAll()
})

it('releases the restart fence after startup failure and retries without duplicating carriers', async () => {
  let count = 0; let failed = false; const active = new Set<number>()
  const driver: CommunityRuntimeDriverPort = { rebuild: async () => [], start: async userId => {
    count++; if (failed) throw new Error('fixture start failed')
    const instance = { userId, processId: count, origin: `http://127.0.0.1:${4100 + count}`, launchUrl: `http://127.0.0.1:${4100 + count}/launch` }; active.add(count); return instance
  }, alive: async instance => active.has(instance.processId), stop: async instance => { active.delete(instance.processId) }, detach: async () => {} }
  const runtime = new CommunityInstanceLifecycle(driver, () => ({ url: 'http://127.0.0.1:3081/model', token: 'fixture-token' }))
  await runtime.ensure('alice', 'https://community.example/'); failed = true
  await expect(runtime.restart('alice', 'https://community.example/')).rejects.toThrow('fixture start failed')
  expect(runtime.status('alice').state).toBe('stopped'); expect(active.size).toBe(0)
  failed = false; const recovered = await runtime.restart('alice', 'https://community.example/')
  expect(active).toEqual(new Set([recovered.processId])); await runtime.stopAll()
})

it('serializes environment preparation after an existing restart, fences intake and never lets a concurrent restart skip the reset', async () => {
  const events: string[] = []; let pid = 0; const active = new Map<string, number>()
  let prepared!: () => void; const preparation = new Promise<void>(resolve => { prepared = resolve })
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const driver: CommunityRuntimeDriverPort = { rebuild: async () => [], alive: async instance => active.get(instance.userId) === instance.processId,
    start: async userId => { expect(active.has(userId)).toBe(false); active.set(userId, ++pid); events.push(`start:${userId}`); return { userId, processId: pid, origin: 'http://127.0.0.1:4101', launchUrl: 'http://127.0.0.1:4101/launch' } },
    stop: async instance => { events.push(`stop:${instance.userId}`); active.delete(instance.userId) }, detach: async () => {} }
  const runtime = new CommunityInstanceLifecycle(driver, () => ({ url: 'http://127.0.0.1:3081/model', token: 'scoped-fixture' }))
  await runtime.ensure('alice', 'https://community.example'); const bob = await runtime.ensure('bob', 'https://community.example'); events.length = 0
  const first = runtime.restart('alice', 'https://community.example')
  const reset = runtime.recover('alice', 'https://community.example', async () => { events.push('backup'); prepared(); await gate; events.push('reset') })
  await preparation; await expect(runtime.ensure('alice', 'https://community.example')).rejects.toMatchObject({ reason: 'draining' })
  expect(await runtime.ensure('bob', 'https://community.example')).toEqual(bob)
  release(); await Promise.all([first, reset])
  expect(events).toEqual(['stop:alice', 'start:alice', 'stop:alice', 'backup', 'reset', 'start:alice'])
  await expect(runtime.recover('alice', 'https://community.example', async () => { throw new Error('fixture backup failure') })).rejects.toThrow('fixture backup failure')
  expect(runtime.status('alice')).toEqual({ state: 'stopped' })
  expect((await runtime.ensure('alice', 'https://community.example')).userId).toBe('alice')
  await runtime.stopAll()
})
