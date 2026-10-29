import { describe, expect, it } from 'vitest'
import type { ExecutionConfiguration, ExecutionEvent } from '../src/domain/platform-execution.js'
import { ExecutionFailure } from '../src/domain/platform-execution.js'
import type { ExecutionOwnersPort, ExecutionRunnerPort } from '../src/ports/platform-execution.js'
import { PlatformExecution } from '../src/use-cases/platform-execution.js'

function fixture() {
  let eligible = true
  let configured: ExecutionConfiguration = {
    enabled: true,
    commands: [{ command: 'news-cli', blocked: [] }],
    variables: [{ name: 'NEWS_KEY', value: 'platform-only-secret', secret: true }],
  }
  const events: ExecutionEvent[] = []
  const calls: Parameters<ExecutionRunnerPort['run']>[0][] = []
  const owners: ExecutionOwnersPort = {
    get: id => (id === 'skill:news' ? { id, version: 'content-v1' } : undefined),
    owns: async (username, id) => eligible && username === 'member' && id === 'skill:news',
  }
  const runner: ExecutionRunnerPort = {
    run: async (input, emit) => {
      calls.push(input)
      await emit({ stream: 'stdout', data: input.stdin })
      await emit({ stream: 'stderr', data: new TextEncoder().encode('diagnostic') })
      return 7
    },
  }
  const execution = new PlatformExecution(owners, { get: async () => configured }, runner)
  const request = {
    username: 'member',
    owner: 'skill:news',
    command: 'news-cli',
    argv: ['hot', '--limit', '10'],
    cwd: '/member/workspace',
    stdin: new TextEncoder().encode('input\u0000bytes'),
  }
  const run = () =>
    execution.execute(
      request,
      async event => {
        events.push(event)
      },
      new AbortController().signal,
    )
  return {
    run,
    request,
    calls,
    events,
    configure: (value: Partial<ExecutionConfiguration>) => {
      configured = { ...configured, ...value }
    },
    revoke: () => {
      eligible = false
    },
  }
}

describe('platform execution ownership and forwarding', () => {
  it('handles a maximum-length near-matching secret across chunks without exposing its completed value', async () => {
    const prefix = 'a'.repeat(65_535),
      output: Uint8Array[] = []
    const execution = new PlatformExecution(
      { get: id => ({ id, version: 'version' }), owns: async () => true },
      {
        get: async () => ({
          enabled: true,
          commands: [{ command: 'run', blocked: [] }],
          variables: [{ name: 'PRIVATE_KEY', secret: true, value: prefix + 'b' }],
        }),
      },
      {
        run: async (_input, emit) => {
          await emit({ stream: 'stdout', data: new TextEncoder().encode('a' + prefix) })
          await emit({ stream: 'stdout', data: new TextEncoder().encode('b') })
          return 0
        },
      },
    )
    await execution.execute(
      { username: 'member', owner: 'skill:example', command: 'run', argv: [], cwd: '/workspace', stdin: new Uint8Array() },
      async event => {
        output.push(event.data)
      },
      new AbortController().signal,
    )
    expect(output.map(bytes => new TextDecoder().decode(bytes)).join('')).toBe('a[redacted]')
  })
  it('preserves a cancelled runner failure without waiting for buffered output delivery', async () => {
    const controller = new AbortController(),
      failure = new ExecutionFailure('timeout')
    let release!: () => void,
      settled = false
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const execution = new PlatformExecution(
      { get: id => ({ id, version: 'version' }), owns: async () => true },
      {
        get: async () => ({
          enabled: true,
          commands: [{ command: 'run', blocked: [] }],
          variables: [{ name: 'PRIVATE_KEY', secret: true, value: 'fictional-private-key' }],
        }),
      },
      {
        run: async (_input, emit) => {
          await emit({ stream: 'stdout', data: new TextEncoder().encode('fictional-') })
          controller.abort(failure)
          throw failure
        },
      },
    )
    const running = execution.execute(
      { username: 'member', owner: 'skill:example', command: 'run', argv: [], cwd: '/workspace', stdin: new Uint8Array() },
      async () => {
        await held
      },
      controller.signal,
    )
    const result = running.then(
      () => {
        settled = true
        return undefined
      },
      error => {
        settled = true
        return error
      },
    )
    try {
      await expect.poll(() => settled).toBe(true)
      expect(await result).toBe(failure)
    } finally {
      release()
      await result
    }
  })
  it('masks secret variables echoed across output chunks and JSON encodings on both streams', async () => {
    const value = 'fictional-"private\\key'
    const events: ExecutionEvent[] = []
    const execution = new PlatformExecution(
      { get: id => ({ id, version: 'version' }), owns: async () => true },
      { get: async () => ({ enabled: true, commands: [{ command: 'run', blocked: [] }], variables: [{ name: 'PRIVATE_KEY', secret: true, value }] }) },
      {
        run: async (_input, emit) => {
          await emit({ stream: 'stdout', data: new TextEncoder().encode('before ' + value.slice(0, 9)) })
          await emit({ stream: 'stdout', data: new TextEncoder().encode(value.slice(9) + ' after') })
          await emit({ stream: 'stderr', data: new TextEncoder().encode(JSON.stringify(value)) })
          return 0
        },
      },
    )
    await execution.execute(
      { username: 'member', owner: 'skill:example', command: 'run', argv: [], cwd: '/workspace', stdin: new Uint8Array() },
      async event => {
        events.push(event)
      },
      new AbortController().signal,
    )
    const output = (stream: ExecutionEvent['stream']) =>
      events
        .filter(event => event.stream === stream)
        .map(event => new TextDecoder().decode(event.data))
        .join('')
    expect(output('stdout')).toBe('before [redacted] after')
    expect(output('stderr')).toBe('"[redacted]"')
  })
  it('forwards argv, cwd, binary stdin, both output streams and the command exit code', async () => {
    const f = fixture()
    expect(await f.run()).toBe(7)
    expect(f.calls[0]).toMatchObject({ ...f.request, environment: { NEWS_KEY: 'platform-only-secret' } })
    expect(f.events).toEqual([
      { stream: 'stdout', data: f.request.stdin },
      { stream: 'stderr', data: new TextEncoder().encode('diagnostic') },
    ])
  })
  it.each(['revoked', 'different-member', 'missing-owner', 'disabled', 'missing-command'] as const)('refuses %s before invoking an executor', async reason => {
    const f = fixture()
    if (reason === 'revoked') f.revoke()
    if (reason === 'different-member') f.request.username = 'other'
    if (reason === 'missing-owner') f.request.owner = 'skill:missing'
    if (reason === 'disabled') f.configure({ enabled: false })
    if (reason === 'missing-command') f.request.command = 'other-cli'
    await expect(f.run()).rejects.toMatchObject({
      code: reason === 'disabled' ? 'disabled' : reason === 'missing-command' ? 'command-missing' : 'unauthorized',
    })
    expect(f.calls).toEqual([])
  })
  it('checks current eligibility and the switch again on every call', async () => {
    const f = fixture()
    await f.run()
    f.revoke()
    await expect(f.run()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(f.calls).toHaveLength(1)
  })
  it('answers a blocked first argument without executing or disclosing credentials', async () => {
    const f = fixture()
    f.configure({ commands: [{ command: 'news-cli', blocked: ['apikey-get'] }] })
    f.request.argv = ['apikey-get']
    expect(await f.run()).toBe(0)
    expect(f.calls).toEqual([])
    expect(new TextDecoder().decode(f.events[0]!.data)).toBe('API Key: Credentials are configured by the platform / 凭据由平台配置。\n')
    expect(JSON.stringify(f.events)).not.toContain('platform-only-secret')
  })
})

it('uses the retained prepared version during refresh and refuses unavailable preparation before starting a runner', async () => {
  const calls: Parameters<ExecutionRunnerPort['run']>[0][] = []
  let available = true
  const execution = new PlatformExecution(
    { get: id => ({ id, version: 'new-version' }), owns: async () => true },
    { get: async () => ({ enabled: true, commands: [{ command: 'scripts/task.py', blocked: [] }], variables: [] }) },
    {
      run: async input => {
        calls.push(input)
        return 0
      },
    },
    {
      withPrepared: async (_owner, run) => {
        if (!available) throw new ExecutionFailure('not-ready')
        return run({ version: 'old-version', dependencies: [] })
      },
    },
  )
  const request = { username: 'member', owner: 'skill:fixture', command: 'scripts/task.py', argv: [], cwd: '/workspace', stdin: new Uint8Array() }
  expect(await execution.execute(request, async () => {}, new AbortController().signal)).toBe(0)
  expect(calls[0]).toMatchObject({ version: 'old-version', dependencies: [] })
  available = false
  await expect(execution.execute(request, async () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'not-ready' })
  expect(calls).toHaveLength(1)
})

it('resolves a declared script alias from the trusted source while keeping its public operation', async () => {
  const f = fixture()
  f.configure({ commands: [{ command: 'scripts/cloud.py', source: 'scripts/audio.py', blocked: [] }] })
  f.request.command = 'scripts/cloud.py'
  expect(await f.run()).toBe(7)
  expect(f.calls[0]?.command).toBe('scripts/audio.py')
})

it.each([
  ['project', '--base-url', 'https://member.example.test'],
  ['--base-url=https://member.example.test'],
  ['project', '--base-u=https://member.example.test'],
  ['--b', 'https://member.example.test'],
  ['--key-e', 'OTHER_KEY'],
])('refuses protected options and parser abbreviations before credentials reach a runner: %j', async (...argv) => {
  const f = fixture()
  f.configure({ commands: [Object.assign({ command: 'news-cli', blocked: [] }, { blockedOptions: ['--base-url', '--key-env'] })] })
  f.request.argv = argv
  expect(await f.run()).toBe(0)
  expect(f.calls).toEqual([])
})
it('allows ordinary options and literal protected-option text after the option terminator', async () => {
  const f = fixture()
  f.configure({ commands: [Object.assign({ command: 'news-cli', blocked: [] }, { blockedOptions: ['--base-url'] })] })
  f.request.argv = ['--model', 'fixture-model', '--', '--base-url']
  expect(await f.run()).toBe(7)
  expect(f.calls).toHaveLength(1)
})
