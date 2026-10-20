import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SqliteUsageRecords } from '../src/adapters/usage-records.js'
import { UsagePolicy } from '../src/use-cases/usage-policy.js'
import { PlatformExecution } from '../src/use-cases/platform-execution.js'

it('records delegated command metadata and its starting group while preserving streams and exit status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'execution-usage-')), store = new SqliteUsageRecords(join(root, 'usage.db'))
  let now = 1000
  const member = { username: 'admin', groupId: 'before' }, actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  const usage = new UsagePolicy(store, { now: () => now }, { get: () => ({ ...actor, groupId: 'after', admin: true, disabled: false, email: '', createdAt: 0, updatedAt: 0 }) })
  const execution = new PlatformExecution({ get: id => ({ id, version: 'v1' }), owns: () => true }, { get: () => ({ enabled: true, commands: [{ command: 'news-cli', blocked: [] }], variables: [] }) },
    { run: async (input, emit) => { member.groupId = 'after'; now = 1250; await emit({ stream: 'stdout', data: input.stdin }); return 7 } }, undefined, undefined, undefined, usage)
  try {
    let output = ''
    const exit = await execution.execute({ username: 'admin', owner: 'skill:news', command: 'news-cli', argv: ['hot', 'PRIVATE_ARGUMENT'], cwd: '/PRIVATE_CWD', stdin: new TextEncoder().encode('PRIVATE_INPUT') }, async event => { output += new TextDecoder().decode(event.data) }, new AbortController().signal, member)
    expect(exit).toBe(7); expect(output).toBe('PRIVATE_INPUT')
    const records = usage.view(actor, {})
    expect(records.items).toMatchObject([{ username: 'admin', groupId: 'before', capability: { kind: 'execution', id: 'skill:news', operation: 'news-cli', firstArgument: 'hot' }, startedAt: 1000, durationMs: 250, exitCode: 7, outcome: 'failed' }])
    expect(JSON.stringify(records)).not.toContain('PRIVATE_')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

it('records policy refusal with a fixed output and nonzero exit without starting execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'execution-policy-')), store = new SqliteUsageRecords(join(root, 'usage.db'))
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }, member = { username: 'admin', groupId: 'admin' }
  const usage = new UsagePolicy(store, { now: () => 1000 }, { get: () => ({ ...actor, groupId: 'admin', admin: true, disabled: false, email: '', createdAt: 0, updatedAt: 0 }) }, { allow: () => false })
  let executed = false
  const execution = new PlatformExecution({ get: id => ({ id, version: 'v1' }), owns: () => true }, { get: () => ({ enabled: true, commands: [{ command: 'news-cli', blocked: [] }], variables: [] }) }, { run: async () => { executed = true; return 0 } }, undefined, undefined, undefined, usage)
  try {
    let output = ''
    expect(await execution.execute({ username: 'admin', owner: 'skill:news', command: 'news-cli', argv: ['hot'], cwd: '/', stdin: new Uint8Array() }, async event => { output += new TextDecoder().decode(event.data) }, new AbortController().signal, member)).toBe(125)
    expect(output).toBe('DSH_PHALANX_EXECUTION[usage-not-allowed]: This use is not allowed / 本次使用未获允许。\n'); expect(executed).toBe(false)
    expect(usage.view(actor, {}).items).toMatchObject([{ outcome: 'denied', reason: 'policy', exitCode: 125 }])
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

it('attributes authenticated HTTP calls and disabled-member refusals without guessing invalid identities', async () => {
  const { createServer } = await import('node:http')
  const { createExecutionGateway } = await import('../src/inbound/execution-gateway.js')
  const { CommunityModelAuthorization } = await import('../src/use-cases/community-model-authorization.js')
  const root = mkdtempSync(join(tmpdir(), 'execution-http-')), store = new SqliteUsageRecords(join(root, 'usage.db'))
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let disabled = false, groupId = 'before', ran = 0, allowed = true
  let entered = () => {}
  const account = (username: string) => ({ username, spaceId: username === 'admin' ? 'admin-space' : 'member-space', sessionEpoch: 0, admin: username === 'admin', groupId, disabled: username === 'member' && disabled, email: '', createdAt: 0, updatedAt: 0 })
  const usage = new UsagePolicy(store, { now: () => 1000 }, { get: account }, { allow: () => allowed })
  const execution = new PlatformExecution({ get: id => ({ id, version: 'v1' }), owns: () => true }, { get: () => ({ enabled: true, commands: [{ command: 'news-cli', blocked: [] }], variables: [] }) }, { run: async (input, _emit, signal) => { ran++; if (input.argv[0] === 'hold') { entered(); return new Promise<number>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } groupId = 'after'; return 0 } }, undefined, undefined, undefined, usage)
  const authorization = new CommunityModelAuthorization({ getState: account, get: account }, { resolve: token => token === 'member' || token === 'retired' ? { username: 'member', spaceId: token === 'member' ? 'member-space' : 'old-space' } : undefined })
  const gateway = createExecutionGateway(execution, authorization, { track() {}, untrack() {} })
  const server = createServer((request, response) => { void gateway(request, response) })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const send = (token: string) => fetch(origin, { method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'skill:news', command: 'news-cli', argv: ['hot', 'PRIVATE_ARGUMENT'], cwd: '/PRIVATE_CWD', stdin: '' }) }).then(response => response.text())
    expect(await send('member')).toContain('"exit":0')
    disabled = true; expect(await send('member')).toContain('"exit":125')
    expect(ran).toBe(1)
    expect(usage.view(actor, {}).items).toMatchObject([{ username: 'member', groupId: 'after', reason: 'unauthorized', outcome: 'denied' }, { username: 'member', groupId: 'before', outcome: 'succeeded' }])
    await send('invalid'); await send('retired')
    expect(usage.view(actor, {}).total).toBe(2)
    disabled = false; allowed = false
    const refused = await send('member'); expect(refused).toContain('\"exit\":125'); expect(refused).toContain(Buffer.from('DSH_PHALANX_EXECUTION[usage-not-allowed]: This use is not allowed / 本次使用未获允许。\n').toString('base64')); expect(ran).toBe(1)
    expect(usage.view(actor, {}).items[0]).toMatchObject({ outcome: 'denied', reason: 'policy', exitCode: 125 })
    allowed = true
    const arrived = new Promise<void>(resolve => { entered = resolve }), abort = new AbortController()
    const pending = fetch(origin, { method: 'POST', signal: abort.signal, headers: { 'x-api-key': 'member', 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'skill:news', command: 'news-cli', argv: ['hold'], cwd: '/', stdin: '' }) }).catch(() => undefined)
    await arrived; abort.abort(); await pending
    await expect.poll(() => usage.view(actor, {}).total).toBe(4)
    expect(usage.view(actor, {}).items[0]).toMatchObject({ outcome: 'failed', reason: 'cancelled' })
    expect(JSON.stringify(usage.view(actor, {}))).not.toContain('PRIVATE_')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }) }
})

it('retains blocked-command behavior and records concurrency, deadlines and cancellation once each', async () => {
  const { ExecutionControl } = await import('../src/use-cases/execution-control.js')
  const { DEFAULT_EXECUTION_LIMITS } = await import('../src/domain/execution-control.js')
  const root = mkdtempSync(join(tmpdir(), 'execution-results-')), store = new SqliteUsageRecords(join(root, 'usage.db'))
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }, member = { username: 'admin', groupId: 'admin' }
  const deadlines: AbortController[] = []
  let entered = () => {}
  const control = new ExecutionControl({ get: () => ({ ...DEFAULT_EXECUTION_LIMITS, memberConcurrency: 1 }), save() {} }, { start: () => { const timer = new AbortController(); deadlines.push(timer); return { signal: timer.signal, dispose() {} } } })
  const usage = new UsagePolicy(store, { now: () => 1000 }, { get: () => ({ ...actor, groupId: 'admin', admin: true, disabled: false, email: '', createdAt: 0, updatedAt: 0 }) })
  const execution = new PlatformExecution({ get: id => ({ id, version: 'v1' }), owns: () => true }, { get: () => ({ enabled: true, commands: [{ command: 'news-cli', blocked: ['apikey-get'] }], variables: [] }) },
    { run: async (_input, _emit, signal) => { entered(); return new Promise<number>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } }, undefined, undefined, control, usage)
  const request = { username: 'admin', owner: 'skill:news', command: 'news-cli', argv: ['hot'], cwd: '/', stdin: new Uint8Array() }
  try {
    let output = ''
    expect(await execution.execute({ ...request, argv: ['apikey-get'] }, async event => { output += new TextDecoder().decode(event.data) }, new AbortController().signal, member)).toBe(0)
    expect(output).toBe('API Key: Credentials are configured by the platform / 凭据由平台配置。\n')
    let arrived = new Promise<void>(resolve => { entered = resolve })
    const timed = execution.execute(request, async () => {}, new AbortController().signal, member)
    await arrived
    await expect(execution.execute(request, async () => {}, new AbortController().signal, member)).rejects.toMatchObject({ code: 'concurrency' })
    deadlines.at(-1)!.abort(); await expect(timed).rejects.toMatchObject({ code: 'timeout' })
    arrived = new Promise<void>(resolve => { entered = resolve })
    const abort = new AbortController(), cancelled = execution.execute(request, async () => {}, abort.signal, member)
    await arrived; abort.abort(); await expect(cancelled).rejects.toBeDefined()
    expect(usage.view(actor, {}).items).toMatchObject([
      { reason: 'cancelled', outcome: 'failed' }, { reason: 'timeout', outcome: 'failed' },
      { reason: 'concurrency', outcome: 'denied' }, { reason: 'blocked', outcome: 'denied', exitCode: 0, capability: { firstArgument: 'apikey-get' } },
    ])
    expect(usage.view(actor, {}).total).toBe(4)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
