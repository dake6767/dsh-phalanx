import { expect, it } from 'vitest'
import { McpSharedRuntime } from '../src/use-cases/mcp-shared-runtime.js'
import { ExecutionControl } from '../src/use-cases/execution-control.js'
import { DEFAULT_EXECUTION_LIMITS } from '../src/domain/execution-control.js'
import type { McpService } from '../src/domain/mcp-service.js'
import type { McpSharedProcessPort } from '../src/ports/mcp-shared-runtime.js'

it('keeps one process per member and service, shares skill concurrency and stops revoked, rotated or idle processes', async () => {
  let now = 0, sweep = () => {}, permitted = true
  let service: McpService = { name: 'p-search', url: '', description: '', generation: 1, prepared: { directory: '/private/prepared' }, run: { location: 'shared', command: 'search', args: [], env: [], prepareCommand: '' } }
  const live = new Set<number>(), activity = new Map<number, () => void>(); let next = 0
  const process: McpSharedProcessPort = { isolated: true, recover: async () => {}, start: async (_service, active, signal) => {
    const id = ++next; live.add(id); activity.set(id, active)
    const closed = new Promise<number>(resolve => { signal.addEventListener('abort', () => { live.delete(id); resolve(0) }, { once: true }) })
    return { target: { name: service.name, baseUrl: `http://127.0.0.1:${4000 + id}/mcp`, credential: '', headers: [] }, closed }
  } }
  const control = new ExecutionControl({ get: () => ({ ...DEFAULT_EXECUTION_LIMITS, memberConcurrency: 1, platformConcurrency: 2 }), save() {} }, { append() {}, list: () => [], prune() {} }, { now: () => now }, { start: () => ({ signal: new AbortController().signal, dispose() {} }) })
  const runtime = new McpSharedRuntime(process, control, { now: () => now }, { start: callback => { sweep = callback; return () => {} } }, () => permitted ? service : undefined, 10)
  runtime.start()
  try {
    const first = await runtime.connect('alice', service, false)
    expect(await runtime.connect('alice', service, false)).toEqual(first)
    expect((await runtime.connect('bob', service, false)).baseUrl).not.toBe(first.baseUrl)
    const request = { username: 'carol', owner: 'skill:search', command: 'search', argv: [], cwd: '', stdin: new Uint8Array() }
    await expect(control.run(request, new AbortController().signal, async () => 0)).rejects.toMatchObject({ code: 'concurrency' })
    permitted = false; await runtime.reconcile(); expect(live.size).toBe(0)
    permitted = true; await runtime.connect('alice', service, false)
    service = { ...service, generation: 2 }; await runtime.connect('alice', service, false); expect(live.size).toBe(1)
    now = 9_000; activity.get(next)!(); now = 15_000; sweep(); expect(live.size).toBe(1)
    now = 20_000; sweep(); await runtime.reconcile(); expect(live.size).toBe(0)
    expect(await control.run(request, new AbortController().signal, async () => 0)).toBe(0)
  } finally { await runtime.stop() }
})

it('keeps global admission until a cancelled startup carrier has actually closed', async () => {
  let release!: () => void, closed!: () => void, draining!: () => void
  const startup = new Promise<void>(resolve => { release = resolve }), cleanup = new Promise<number>(resolve => { closed = () => resolve(0) }), drain = new Promise<void>(resolve => { draining = resolve })
  const service: McpService = { name: 'p-search', description: '', url: '', generation: 1, prepared: { directory: '/private/deps' }, run: { location: 'shared', command: 'search', args: [], env: [], prepareCommand: '' } }
  const control = new ExecutionControl({ get: () => ({ ...DEFAULT_EXECUTION_LIMITS, platformConcurrency: 1 }), save() {} }, { append() {}, list: () => [], prune() {} }, { now: () => 0 }, { start: () => ({ signal: new AbortController().signal, dispose() {} }) })
  const runtime = new McpSharedRuntime({ isolated: true, recover: async () => {}, start: async () => { await startup; return { target: { name: 'p-search', baseUrl: 'http://127.0.0.1', credential: '', headers: [] }, get closed() { draining(); return cleanup } } } }, control, { now: () => 0 }, { start: () => () => {} }, () => service)
  const connecting = runtime.connect('alice', service, false).catch(() => {})
  const stopping = runtime.stop(); release()
  try {
    await drain
    await expect(control.run({ username: 'bob', owner: 'skill:search', command: 'search', argv: [], cwd: '', stdin: new Uint8Array() }, new AbortController().signal, async () => 0)).rejects.toMatchObject({ code: 'concurrency' })
  } finally { closed(); await stopping; await connecting }
})
