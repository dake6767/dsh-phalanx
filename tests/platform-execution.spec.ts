import { describe, expect, it } from 'vitest'
import { PlatformExecution } from '../src/use-cases/platform-execution.js'
import type { ExecutionConfiguration, ExecutionEvent } from '../src/domain/platform-execution.js'
import type { ExecutionOwnersPort, ExecutionRunnerPort } from '../src/ports/platform-execution.js'
import { ExecutionFailure } from '../src/domain/platform-execution.js'

function fixture() {
  let eligible = true
  let configured: ExecutionConfiguration = { enabled: true, commands: [{ command: 'news-cli', blocked: [] }], variables: [{ name: 'NEWS_KEY', value: 'platform-only-secret', secret: true }] }
  const events: ExecutionEvent[] = []
  const calls: Parameters<ExecutionRunnerPort['run']>[0][] = []
  const owners: ExecutionOwnersPort = {
    get: id => id === 'skill:news' ? { id, version: 'content-v1' } : undefined,
    owns: (username, id) => eligible && username === 'member' && id === 'skill:news',
  }
  const runner: ExecutionRunnerPort = {
    run: async (input, emit) => { calls.push(input); await emit({ stream: 'stdout', data: input.stdin }); await emit({ stream: 'stderr', data: new TextEncoder().encode('diagnostic') }); return 7 },
  }
  const execution = new PlatformExecution(owners, { get: () => configured }, runner)
  const request = { username: 'member', owner: 'skill:news', command: 'news-cli', argv: ['hot', '--limit', '10'], cwd: '/member/workspace', stdin: new TextEncoder().encode('input\u0000bytes') }
  const run = () => execution.execute(request, async event => { events.push(event) }, new AbortController().signal)
  return { run, request, calls, events, configure: (value: Partial<ExecutionConfiguration>) => { configured = { ...configured, ...value } }, revoke: () => { eligible = false } }
}

describe('platform execution ownership and forwarding', () => {
  it('forwards argv, cwd, binary stdin, both output streams and the command exit code', async () => {
    const f = fixture()
    expect(await f.run()).toBe(7)
    expect(f.calls[0]).toMatchObject({ ...f.request, environment: { NEWS_KEY: 'platform-only-secret' } })
    expect(f.events).toEqual([{ stream: 'stdout', data: f.request.stdin }, { stream: 'stderr', data: new TextEncoder().encode('diagnostic') }])
  })
  it.each(['revoked', 'different-member', 'missing-owner', 'disabled', 'missing-command'] as const)('refuses %s before invoking an executor', async reason => {
    const f = fixture()
    if (reason === 'revoked') f.revoke()
    if (reason === 'different-member') f.request.username = 'other'
    if (reason === 'missing-owner') f.request.owner = 'skill:missing'
    if (reason === 'disabled') f.configure({ enabled: false })
    if (reason === 'missing-command') f.request.command = 'other-cli'
    await expect(f.run()).rejects.toMatchObject({ code: reason === 'disabled' ? 'disabled' : reason === 'missing-command' ? 'command-missing' : 'unauthorized' })
    expect(f.calls).toEqual([])
  })
  it('checks current eligibility and the switch again on every call', async () => {
    const f = fixture(); await f.run(); f.revoke()
    await expect(f.run()).rejects.toMatchObject({ code: 'unauthorized' }); expect(f.calls).toHaveLength(1)
  })
  it('answers a blocked first argument without executing or disclosing credentials', async () => {
    const f = fixture(); f.configure({ commands: [{ command: 'news-cli', blocked: ['apikey-get'] }] }); f.request.argv = ['apikey-get']
    expect(await f.run()).toBe(0); expect(f.calls).toEqual([])
    expect(new TextDecoder().decode(f.events[0]!.data)).toContain('Credentials are configured by the platform')
    expect(JSON.stringify(f.events)).not.toContain('platform-only-secret')
  })
})

it('uses the retained prepared version during refresh and refuses unavailable preparation before starting a runner', async () => {
  const calls: Parameters<ExecutionRunnerPort['run']>[0][] = []; let available = true
  const execution = new PlatformExecution({ get: id => ({ id, version: 'new-version' }), owns: () => true },
    { get: () => ({ enabled: true, commands: [{ command: 'scripts/task.py', blocked: [] }], variables: [] }) },
    { run: async input => { calls.push(input); return 0 } },
    { withPrepared: async (_owner, run) => { if (!available) throw new ExecutionFailure('not-ready'); return run({ id: 'retained-artifact', version: 'old-version', hash: 'old-hash', log: '' }) } })
  const request = { username: 'member', owner: 'skill:fixture', command: 'scripts/task.py', argv: [], cwd: '/workspace', stdin: new Uint8Array() }
  expect(await execution.execute(request, async () => {}, new AbortController().signal)).toBe(0)
  expect(calls[0]).toMatchObject({ version: 'old-version', artifact: 'retained-artifact' })
  available = false
  await expect(execution.execute(request, async () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'not-ready' })
  expect(calls).toHaveLength(1)
})
