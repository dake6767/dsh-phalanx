import { expect, it } from 'vitest'
import { InstanceInspection, inspectCapabilities } from '../src/adapters/instance-inspection.js'
const fallback = { managedFailures: ['unavailable'], expertFailures: [{ id: 'writer', entries: ['preset'] }] }
import type { CommunityUserInstance } from '../src/ports/community-runtime.js'
function instance(): CommunityUserInstance {
  return {
    userId: 'member',
    processId: 1,
    origin: 'http://localhost',
    launchUrl: 'http://localhost',
    managedFailures: ['preparation'],
    expertFailures: [{ id: 'writer', entries: ['skill:missing'] }],
  }
}
function gate() {
  let release!: () => void
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  return { release, pending }
}
it('returns before inspection ends and publishes both results atomically on the exact instance', async () => {
  const owner = new InstanceInspection(),
    current = instance(),
    pause = gate()
  const completed = owner.start(
    current,
    async () => {
      await pause.pending
      return { managedFailures: ['preparation', 'plugin'], expertFailures: [{ id: 'writer', entries: ['skill:missing', 'preset'] }] }
    },
    fallback,
  )
  expect(current.inspection).toBe('checking')
  expect(current.managedFailures).toEqual(['preparation'])
  pause.release()
  await completed
  expect(current.inspection).toBe('complete')
  expect(current.managedFailures).toEqual(['preparation', 'plugin'])
  expect(current.expertFailures).toEqual([{ id: 'writer', entries: ['skill:missing', 'preset'] }])
})
it('cancels and drains the old inspection without publishing its results to either carrier', async () => {
  const owner = new InstanceInspection(),
    old = instance(),
    replacement = instance(),
    aborted = gate(),
    pause = gate(),
    entered = gate()
  const pending = owner.start(
    old,
    async signal => {
      signal.addEventListener('abort', aborted.release, { once: true })
      entered.release()
      await pause.pending
      return { managedFailures: ['old'], expertFailures: [] }
    },
    fallback,
  )
  await entered.pending
  const stopping = owner.stop(old)
  await aborted.pending
  owner.start(replacement, async () => ({ managedFailures: [], expertFailures: [] }), fallback)
  pause.release()
  await stopping
  await pending
  expect(old.managedFailures).toEqual(['preparation'])
  expect(replacement.managedFailures).toEqual([])
  expect(replacement.inspection).toBe('complete')
})
it('reports unavailable capabilities when inspection unexpectedly fails', async () => {
  const owner = new InstanceInspection(),
    current = instance()
  await owner.start(
    current,
    async () => {
      throw Error('Diagnostic details stay private')
    },
    fallback,
  )
  expect(current.inspection).toBe('complete')
  expect(current.managedFailures).toEqual(['unavailable'])
  await owner.stop(current)
})
it('checks each carrier once even when later navigation reuses that ready instance', async () => {
  const owner = new InstanceInspection(),
    current = instance()
  let calls = 0
  const inspect = async () => {
    calls++
    return { managedFailures: [], expertFailures: [] }
  }
  await owner.start(current, inspect, fallback)
  await owner.start(current, inspect, fallback)
  expect(calls).toBe(1)
})

it('waits for both cancelled inventory branches before allowing carrier cleanup', async () => {
  const owner = new InstanceInspection(),
    current = instance(),
    entered = gate(),
    cleanup = gate()
  const pending = owner.start(
    current,
    async signal => {
      const managed = new Promise<readonly string[]>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason)
          },
          { once: true },
        )
      })
      const experts = (async () => {
        entered.release()
        await cleanup.pending
        return []
      })()
      return await inspectCapabilities(managed, experts)
    },
    fallback,
  )
  await entered.pending
  const stopping = owner.stop(current)
  expect(
    await Promise.race([
      stopping.then(() => 'stopped'),
      new Promise<string>(resolve => {
        setImmediate(() => resolve('draining'))
      }),
    ]),
  ).toBe('draining')
  cleanup.release()
  await stopping
  await pending
  expect(current.managedFailures).toEqual(['preparation'])
})
