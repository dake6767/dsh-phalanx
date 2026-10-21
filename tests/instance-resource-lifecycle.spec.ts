import { expect, it } from 'vitest'
import { CommunityInstanceLifecycle } from '../src/use-cases/community-instance-lifecycle.js'
import type { CommunityRuntimeDriverPort } from '../src/ports/community-runtime-driver.js'
import type { CommunityUserInstance } from '../src/ports/community-runtime.js'
import { UNLIMITED_INSTANCE_RESOURCES, type InstanceResourceLimits } from '../src/domain/instance-resources.js'

function fixture() {
  let configured: InstanceResourceLimits = UNLIMITED_INSTANCE_RESOURCES, sequence = 0
  const starts: string[] = [], stops: string[] = [], updates: string[] = []
  const driver: CommunityRuntimeDriverPort = {
    rebuild: async () => [], alive: async () => true, detach: async () => {}, stop: async instance => { stops.push(instance.resourceKey!) },
    start: async userId => { const resourceKey = String(++sequence); starts.push(resourceKey); return { userId, resourceKey, processId: sequence, origin: 'http://localhost', launchUrl: 'http://localhost', resourceLimits: { limits: configured, swapMiB: configured.memoryMiB === null ? null : 0 } } },
    applyResources: async (instance, limits) => { updates.push(instance.resourceKey!); Object.assign(instance, { resourceLimits: { limits, swapMiB: limits.memoryMiB === null ? null : 0 } }); return instance.resourceLimits! },
  }
  const runtime = new CommunityInstanceLifecycle(driver, () => ({ url: 'http://localhost', token: 'fictional' }))
  return { runtime, driver, starts, stops, updates, configure: (limits: InstanceResourceLimits) => { configured = limits } }
}

it('updates only the exact registered member instance without restarting it', async () => {
  const f = fixture(), instance = await f.runtime.ensure('member', 'http://localhost'), target = { cpus: 0.5, memoryMiB: 512, pids: 128 }
  f.configure(target)
  const result = await f.runtime.applyResources(instance, target, 'http://localhost', async () => { throw Error('Must not interrupt a live update') })
  expect(result).toEqual({ instance, method: 'updated' })
  expect(f.starts).toEqual(['1']); expect(f.stops).toEqual([]); expect(f.updates).toEqual(['1'])
})

it('falls back inside the same maintenance fence when the kernel limits did not change', async () => {
  const f = fixture(), limited = { cpus: 1, memoryMiB: 512, pids: 128 }
  f.configure(limited)
  const first = await f.runtime.ensure('member', 'http://localhost')
  f.configure(UNLIMITED_INSTANCE_RESOURCES)
  f.driver.applyResources = async instance => instance.resourceLimits!
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { entered = resolve })
  const applying = f.runtime.applyResources(first, UNLIMITED_INSTANCE_RESOURCES, 'http://localhost', async () => { entered(); await gate })
  await reached
  expect(f.runtime.status('member').state).toBe('draining')
  await expect(f.runtime.ensure('member', 'http://localhost')).rejects.toMatchObject({ reason: 'draining' })
  release()
  const result = await applying
  expect(result.method).toBe('restarted'); expect(result.instance).not.toBe(first)
  expect(result.instance.resourceLimits).toEqual({ limits: UNLIMITED_INSTANCE_RESOURCES, swapMiB: null })
  expect(f.stops).toEqual(['1']); expect(f.starts).toEqual(['1', '2'])
})

it('never applies an old confirmation to a replacement carrier', async () => {
  const f = fixture(), first = await f.runtime.ensure('member', 'http://localhost')
  const next = await f.runtime.restart('member', 'http://localhost')
  await expect(f.runtime.applyResources(first, { cpus: 1, memoryMiB: 512, pids: 128 }, 'http://localhost', async () => {})).rejects.toThrow()
  expect(f.runtime.status('member')).toEqual({ state: 'ready', instance: next })
  expect(f.updates).toEqual([]); expect(f.stops).toEqual(['1'])
})

it('drains an in-flight update during shutdown and does not start a fallback replacement', async () => {
  const f = fixture(), first = await f.runtime.ensure('member', 'http://localhost')
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { entered = resolve })
  f.driver.applyResources = async (instance: CommunityUserInstance) => { entered(); await gate; return instance.resourceLimits! }
  const applying = f.runtime.applyResources(first, { cpus: 1, memoryMiB: 512, pids: 128 }, 'http://localhost', async () => { throw Error('No fallback after shutdown') })
  const rejected = expect(applying).rejects.toMatchObject({ reason: 'shutdown' })
  await reached
  const stopping = f.runtime.stopAll()
  release(); await rejected; await stopping
  expect(f.starts).toEqual(['1'])
})
