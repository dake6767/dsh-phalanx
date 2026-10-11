import { expect, it } from 'vitest'
import { ExecutionControl } from '../src/use-cases/execution-control.js'
import { DEFAULT_EXECUTION_LIMITS, type ExecutionRecord } from '../src/domain/execution-control.js'

it('enforces member and global concurrency, cancels deadlines, and records outcomes without arguments or output', async () => {
  let now = 1000
  const records: ExecutionRecord[] = [], deadlines: AbortController[] = []
  const control = new ExecutionControl({ get: () => ({ ...DEFAULT_EXECUTION_LIMITS, memberConcurrency: 1, platformConcurrency: 2 }), save: () => {} },
    { append: row => { records.push(row) }, list: () => records, prune: () => {} }, { now: () => now },
    { start: () => { const controller = new AbortController(); deadlines.push(controller); return { signal: controller.signal, dispose: () => {} } } })
  const request = { username: 'member', owner: 'skill:news', command: 'news-cli', argv: ['private-search'], stdin: new TextEncoder().encode('private-input'), cwd: '/workspace' }
  const run = (username: string) => control.run({ ...request, username }, new AbortController().signal, signal => new Promise<number>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) }))
  const first = run('member')
  await expect(run('member')).rejects.toMatchObject({ code: 'concurrency' })
  const second = run('another')
  await expect(run('third')).rejects.toMatchObject({ code: 'concurrency' })
  now = 1300; deadlines[0]!.abort()
  await expect(first).rejects.toMatchObject({ code: 'timeout' })
  deadlines[1]!.abort(); await expect(second).rejects.toMatchObject({ code: 'timeout' })
  expect(await control.run(request, new AbortController().signal, async () => 7)).toBe(7)
  expect(records).toContainEqual({ username: 'member', owner: 'skill:news', command: 'news-cli', startedAt: 1000, durationMs: 300, reason: 'timeout' })
  expect(JSON.stringify(records)).not.toMatch(/private-search|private-input|argv|stdin|stdout|stderr|cwd/)
  expect(records.at(-1)).toMatchObject({ exitCode: 7 })
})

it('cleans thirty-day records on its independent maintenance schedule and stops that schedule on shutdown', () => {
  let now = 0, scheduled: (() => void) | undefined, stopped = false
  let rows: ExecutionRecord[] = [{ username: 'member', owner: 'skill:old', command: 'old-cli', startedAt: 0, durationMs: 1, exitCode: 0 }]
  const control = new ExecutionControl({ get: () => DEFAULT_EXECUTION_LIMITS, save() {} }, { append() {}, list: () => rows, prune: before => { rows = rows.filter(row => row.startedAt >= before) } }, { now: () => now }, { start: () => ({ signal: new AbortController().signal, dispose() {} }) },
    { start: cleanup => { scheduled = cleanup; return () => { stopped = true } } })
  control.start(); expect(rows).toHaveLength(1)
  now = 31 * 24 * 60 * 60 * 1000; scheduled!()
  expect(rows).toEqual([])
  control.stop(); expect(stopped).toBe(true)
})
