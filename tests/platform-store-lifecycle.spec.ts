import { expect, it } from 'vitest'
import { PlatformStoreLifecycle } from '../src/adapters/platform-store-lifecycle.js'

const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => ((resolve = done), (reject = fail)))
  return { promise, resolve, reject }
}

it('initializes once and shares the result', async () => {
  const lifecycle = new PlatformStoreLifecycle('Fixture storage')
  let loads = 0
  const load = async () => void loads++
  await Promise.all([lifecycle.initialize(load), lifecycle.initialize(load)])
  await lifecycle.initialize(load)
  expect(loads).toBe(1)
})

it('serializes writes in order and keeps accepting after a failed write', async () => {
  const lifecycle = new PlatformStoreLifecycle('Fixture storage')
  const order: string[] = [],
    first = deferred()
  const a = lifecycle.write(async () => {
    await first.promise
    order.push('a')
  })
  const b = lifecycle.write(async () => {
    order.push('b')
    throw Error('rejected b')
  })
  const c = lifecycle.write(async () => (order.push('c'), 'c-result'))
  first.resolve()
  await a
  await expect(b).rejects.toThrow('rejected b')
  expect(await c).toBe('c-result')
  expect(order).toEqual(['a', 'b', 'c'])
})

it('drains accepted writes before releasing state, then refuses new work with the store name', async () => {
  const lifecycle = new PlatformStoreLifecycle('Fixture storage')
  const pending = deferred(),
    events: string[] = []
  const write = lifecycle.write(async () => {
    await pending.promise
    events.push('write finished')
  })
  const closed = lifecycle.close(() => events.push('released'))
  await expect(lifecycle.write(async () => {})).rejects.toThrow('Fixture storage is closed')
  expect(() => lifecycle.assertAccepting()).toThrow('Fixture storage is closed')
  expect(() => lifecycle.assertOpen()).not.toThrow()
  pending.resolve()
  await write
  await closed
  expect(events).toEqual(['write finished', 'released'])
  expect(() => lifecycle.assertOpen()).toThrow('Fixture storage is closed')
  await expect(lifecycle.initialize(async () => {})).rejects.toThrow('Fixture storage is closed')
})

it('closes after a failed initialization and runs release exactly once', async () => {
  const lifecycle = new PlatformStoreLifecycle('Fixture storage')
  let releases = 0
  await expect(lifecycle.initialize(() => Promise.reject(Error('load failed')))).rejects.toThrow('load failed')
  await Promise.all([lifecycle.close(() => void releases++), lifecycle.close(() => void releases++)])
  expect(releases).toBe(1)
})

it('waits for an initialization still in progress before releasing, then refuses to initialize again', async () => {
  const lifecycle = new PlatformStoreLifecycle('Fixture storage')
  const loading = deferred(),
    events: string[] = []
  const initialized = lifecycle.initialize(async () => {
    await loading.promise
    events.push('loaded')
  })
  const closed = lifecycle.close(() => events.push('released'))
  loading.resolve()
  await initialized
  await closed
  expect(events).toEqual(['loaded', 'released'])
  await expect(lifecycle.initialize(async () => {})).rejects.toThrow('Fixture storage is closed')
})
