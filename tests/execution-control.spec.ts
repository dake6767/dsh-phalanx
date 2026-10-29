import { expect, it } from 'vitest'
import { ExecutionControl } from '../src/use-cases/execution-control.js'
import { DEFAULT_EXECUTION_LIMITS } from '../src/domain/execution-control.js'

it('enforces member and global concurrency, disposes deadlines, and releases admission after failures', async () => {
  let disposed = 0
  const deadlines: AbortController[] = []
  const control = new ExecutionControl(
    { get: async () => ({ ...DEFAULT_EXECUTION_LIMITS, memberConcurrency: 1, platformConcurrency: 2 }), save: async () => {} },
    {
      start: () => {
        const controller = new AbortController()
        deadlines.push(controller)
        return {
          signal: controller.signal,
          dispose: () => {
            disposed++
          },
        }
      },
    },
  )
  const request = {
    username: 'member',
    owner: 'skill:news',
    command: 'news-cli',
    argv: ['private-search'],
    stdin: new TextEncoder().encode('private-input'),
    cwd: '/workspace',
  }
  const run = (username: string) =>
    control.run(
      { ...request, username },
      new AbortController().signal,
      signal =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
  const first = run('member')
  await expect(run('member')).rejects.toMatchObject({ code: 'concurrency' })
  const second = run('another')
  await expect(run('third')).rejects.toMatchObject({ code: 'concurrency' })
  deadlines[0]!.abort()
  await expect(first).rejects.toMatchObject({ code: 'timeout' })
  deadlines[1]!.abort()
  await expect(second).rejects.toMatchObject({ code: 'timeout' })
  expect(await control.run(request, new AbortController().signal, async () => 7)).toBe(7)
  expect(disposed).toBe(3)
})

it('admits only one contender after their asynchronous limit reads complete together', async () => {
  const reads: (() => void)[] = []
  let release!: () => void
  const active = new Promise<number>(resolve => {
    release = () => resolve(0)
  })
  let started = 0
  const control = new ExecutionControl(
    {
      get: async () => {
        await new Promise<void>(resolve => reads.push(resolve))
        return { ...DEFAULT_EXECUTION_LIMITS, platformConcurrency: 1 }
      },
      save: async () => {},
    },
    { start: () => ({ signal: new AbortController().signal, dispose() {} }) },
  )
  const request = { username: 'member', owner: 'skill:news', command: 'news-cli', argv: [], stdin: new Uint8Array(), cwd: '/workspace' }
  const action = async () => {
    started++
    return active
  }
  const first = control.run(request, new AbortController().signal, action)
  const second = control.run({ ...request, username: 'another' }, new AbortController().signal, action)
  const refused = expect(second).rejects.toMatchObject({ code: 'concurrency' })
  expect(started).toBe(0)
  reads.forEach(resolve => resolve())
  try {
    await refused
    expect(started).toBe(1)
  } finally {
    release()
    await first
  }
})

it('disposes a request deadline before its limit read resolves and fails closed when that read rejects', async () => {
  let finish!: (value: typeof DEFAULT_EXECUTION_LIMITS) => void
  let created = 0
  const control = new ExecutionControl(
    {
      get: () =>
        new Promise(resolve => {
          finish = resolve
        }),
      save: async () => {},
    },
    {
      start: () => {
        created++
        return { signal: new AbortController().signal, dispose() {} }
      },
    },
  )
  const cancelled = control.deadline()
  cancelled.dispose()
  finish(DEFAULT_EXECUTION_LIMITS)
  await Promise.resolve()
  expect(created).toBe(0)
  const unavailable = new Error('database unavailable')
  const failed = new ExecutionControl(
    {
      get: async () => {
        throw unavailable
      },
      save: async () => {},
    },
    {
      start: () => {
        throw Error('must not create a timer')
      },
    },
  ).deadline()
  await new Promise<void>(resolve => failed.signal.addEventListener('abort', () => resolve(), { once: true }))
  expect(failed.signal.reason).toBe(unavailable)
  failed.dispose()
})
