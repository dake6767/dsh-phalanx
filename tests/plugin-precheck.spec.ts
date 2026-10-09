import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { pluginOfflinePrecheck } from '../src/dsh/plugin-precheck.js'

// Execute the disposable-container script with controlled operating-system exits.
// DSH activation itself remains covered by the real Linux container tests.
function startPrecheck() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true }) })
  const fetch = vi.fn()
    .mockResolvedValueOnce({ status: 303, headers: { getSetCookie: () => ['session=fixture; Path=/'] } })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { ok: true, value: [{ moduleName: '@example/slow-plugin', fiberPhase: 'active' }] } }) })
  const execute = new Function('spawn', 'readFile', 'fetch', 'setTimeout', 'clearTimeout', 'console',
    `return (async () => {${pluginOfflinePrecheck.replace(/^import .*;\n/gmu, '')}\n})();`) as (...args: unknown[]) => Promise<void>
  const result: { status: 'pending' | 'passed' | 'failed', error?: Error } = { status: 'pending' }
  const completed = execute(() => child, async () => JSON.stringify({ packageName: '@example/slow-plugin' }), fetch, setTimeout, clearTimeout, { log: () => {} })
    .then(() => { result.status = 'passed' }, (error: Error) => { result.status = 'failed'; result.error = error })
  return { child, fetch, result, completed }
}

afterEach(() => vi.useRealTimers())

it('allows a slow offline boot to activate before the five-minute deadline', async () => {
  vi.useFakeTimers()
  const probe = startPrecheck()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(probe.result.status).toBe('pending')
  probe.child.stdout.emit('data', 'dsh web: http://127.0.0.1:4180/?token=fixture-token\n')
  await probe.completed
  expect(probe.result.status).toBe('passed')
  expect(probe.fetch).toHaveBeenCalledTimes(2)
  expect(probe.child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(vi.getTimerCount()).toBe(0)
})

it('still rejects a boot that never becomes ready and terminates its child', async () => {
  vi.useFakeTimers()
  const probe = startPrecheck()
  await vi.advanceTimersByTimeAsync(299_999)
  expect(probe.result.status).toBe('pending')
  await vi.advanceTimersByTimeAsync(1)
  await probe.completed
  expect(probe.result.status).toBe('failed')
  expect(probe.result.error?.message).toBe('DSH did not become ready')
  expect(probe.fetch).not.toHaveBeenCalled()
  expect(probe.child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(vi.getTimerCount()).toBe(0)
})
