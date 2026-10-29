import { expect, it } from 'vitest'
import { CommunitySupervisor } from '../src/use-cases/community-supervisor.js'
import type { CommunityApplication } from '../src/ports/community-application.js'

it('keeps a diagnostic entry while unavailable and rebuilds only after the failed graph drains', async () => {
  let retry: (() => Promise<void>) | undefined, failure: (() => void) | undefined, release!: () => void
  const drain = new Promise<void>(resolve => {
    release = resolve
  })
  const events: string[] = []
  let builds = 0
  const app: CommunityApplication = {
    start: async () => 'http://entry.test',
    stop: async () => {
      events.push('draining')
      await drain
      events.push('drained')
    },
    onFailure: listener => {
      failure = listener
    },
  }
  const supervisor = new CommunitySupervisor({
    entry: {
      start: async () => {
        events.push('entry')
        return 'http://entry.test'
      },
      suspend: () => {
        events.push('suspend')
      },
      stop: async () => {
        events.push('closed')
      },
    },
    create: async () => {
      builds++
      if (builds === 1) throw Error('fixture database unavailable')
      return app
    },
    schedule: task => {
      retry = async () => {
        retry = undefined
        await task()
      }
      return () => {
        retry = undefined
      }
    },
    retryable: () => true,
    report: () => {},
  })
  expect(await supervisor.start()).toBe('http://entry.test')
  expect(builds).toBe(1)
  await retry!()
  expect(builds).toBe(2)
  failure!()
  expect(events).toContain('suspend')
  expect(builds).toBe(2)
  await Promise.resolve()
  release()
  await supervisor.stop()
  expect(events.indexOf('closed')).toBeGreaterThan(events.indexOf('drained'))
  expect(retry).toBeUndefined()
  expect(builds).toBe(2)
})

it('closes the stable entry even when the business graph cannot finish its shutdown', async () => {
  let closed = false
  const supervisor = new CommunitySupervisor({
    entry: {
      start: async () => 'http://entry.test',
      suspend: () => {},
      stop: async () => {
        closed = true
      },
    },
    create: async () => ({
      start: async () => 'http://entry.test',
      stop: async () => {
        throw Error('fixture drain failed')
      },
    }),
    schedule: () => {
      throw Error('not requested')
    },
    retryable: () => false,
    report: () => {},
  })
  await supervisor.start()
  await expect(supervisor.stop()).rejects.toThrow()
  expect(closed).toBe(true)
})

it('drains a graph constructed after stop without starting or scheduling it', async () => {
  let entered!: () => void,
    release!: (application: CommunityApplication) => void,
    starts = 0,
    stops = 0,
    closed = false
  const began = new Promise<void>(resolve => {
      entered = resolve
    }),
    constructed = new Promise<CommunityApplication>(resolve => {
      release = resolve
    })
  const supervisor = new CommunitySupervisor({
    entry: {
      start: async () => 'http://entry.test',
      suspend: () => {},
      stop: async () => {
        closed = true
      },
    },
    create: async () => {
      entered()
      return await constructed
    },
    schedule: () => {
      throw Error('not requested')
    },
    retryable: () => true,
    report: () => {},
  })
  const starting = supervisor.start()
  await began
  const stopping = supervisor.stop()
  release({
    start: async () => {
      starts++
      return 'http://entry.test'
    },
    stop: async () => {
      stops++
    },
  })
  await starting
  await stopping
  expect(starts).toBe(0)
  expect(stops).toBe(1)
  expect(closed).toBe(true)
})
