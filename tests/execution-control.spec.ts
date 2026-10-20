import { expect, it } from 'vitest'
import { ExecutionControl } from '../src/use-cases/execution-control.js'
import { DEFAULT_EXECUTION_LIMITS } from '../src/domain/execution-control.js'

it('enforces member and global concurrency, disposes deadlines, and releases admission after failures', async () => {
  let disposed = 0
  const deadlines: AbortController[] = []
  const control = new ExecutionControl({ get: () => ({ ...DEFAULT_EXECUTION_LIMITS, memberConcurrency: 1, platformConcurrency: 2 }), save: () => {} },
    { start: () => { const controller = new AbortController(); deadlines.push(controller); return { signal: controller.signal, dispose: () => { disposed++ } } } })
  const request = { username: 'member', owner: 'skill:news', command: 'news-cli', argv: ['private-search'], stdin: new TextEncoder().encode('private-input'), cwd: '/workspace' }
  const run = (username: string) => control.run({ ...request, username }, new AbortController().signal, signal => new Promise<number>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) }))
  const first = run('member')
  await expect(run('member')).rejects.toMatchObject({ code: 'concurrency' })
  const second = run('another')
  await expect(run('third')).rejects.toMatchObject({ code: 'concurrency' })
  deadlines[0]!.abort()
  await expect(first).rejects.toMatchObject({ code: 'timeout' })
  deadlines[1]!.abort(); await expect(second).rejects.toMatchObject({ code: 'timeout' })
  expect(await control.run(request, new AbortController().signal, async () => 7)).toBe(7)
  expect(disposed).toBe(3)
})
