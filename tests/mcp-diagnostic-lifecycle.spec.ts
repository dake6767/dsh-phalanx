import { expect, it } from 'vitest'
import { PlatformDatabaseError } from '../src/domain/platform-database.js'
import { DEFAULT_EXECUTION_LIMITS } from '../src/domain/execution-control.js'
import type { McpService, McpState } from '../src/domain/mcp-service.js'
import { ExecutionControl } from '../src/use-cases/execution-control.js'
import { McpServices } from '../src/use-cases/mcp-services.js'
import { McpSharedRuntime } from '../src/use-cases/mcp-shared-runtime.js'
import { asyncMcpFacts } from './fixtures/async-mcp-facts.js'

function fixture() {
  const actor = { username: 'admin', spaceId: 'admin', sessionEpoch: 0 }
  const account = { ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }
  const candidate: McpService = {
    name: 'p-candidate',
    generation: 2,
    description: '',
    url: '',
    run: { location: 'shared', command: 'node', args: [], env: [] },
  }
  const owner: McpService = {
    name: 'p-owner',
    generation: 1,
    description: '',
    url: 'https://example.test/mcp',
    catalogUpdate: { name: candidate.name, requestId: 'diagnostic-candidate-request', version: '2', baseGeneration: 1, actor, status: 'testing', candidate },
  }
  let state: McpState = { services: [owner], grants: {} }
  let available = true,
    viewError: Error | undefined,
    live = false
  const services = new McpServices(
    { get: async () => account, list: async () => [account], listGroups: async () => [] },
    asyncMcpFacts({ read: () => state }),
    { synchronize: async () => {} },
    {
      ready: () => {
        if (viewError) throw viewError
        return available ? { directory: '/prepared' } : undefined
      },
      view: () => undefined,
      changed: async () => {},
      restart() {},
    },
  )
  const shared = new McpSharedRuntime(
    {
      isolated: true,
      recover: async () => {},
      start: async (_service, _activity, signal) => {
        live = true
        return {
          target: { name: candidate.name, baseUrl: 'http://127.0.0.1:4000', credential: '', headers: [] },
          closed: new Promise<number>(resolve =>
            signal.addEventListener(
              'abort',
              () => {
                live = false
                resolve(0)
              },
              { once: true },
            ),
          ),
        }
      },
    },
    new ExecutionControl(
      { get: async () => DEFAULT_EXECUTION_LIMITS, save: async () => {} },
      { start: () => ({ signal: new AbortController().signal, dispose() {} }) },
    ),
    { now: () => 0 },
    { start: () => () => {} },
    (username, name, diagnostic) => services.runtimeService(username, name, diagnostic),
  )
  return {
    services,
    shared,
    account,
    candidate,
    get live() {
      return live
    },
    removeCandidate() {
      state = { ...state, services: [{ ...owner, catalogUpdate: { ...owner.catalogUpdate!, status: 'failed', candidate: undefined } }] }
    },
    unprepare() {
      available = false
    },
    fail(error: Error) {
      viewError = error
    },
  }
}

it.each([
  ['candidate removed', 'not-found'],
  ['administrator disabled', 'admin-required'],
  ['administrator revoked', 'admin-required'],
  ['preparation unavailable', 'mcp-runtime-not-ready'],
] as const)('retires a diagnostic carrier after confirmed %s without changing the public error', async (change, code) => {
  const f = fixture()
  try {
    await f.shared.connect('admin', await f.services.diagnostic('admin', f.candidate.name), true)
    if (change === 'candidate removed') f.removeCandidate()
    if (change === 'administrator disabled') f.account.disabled = true
    if (change === 'administrator revoked') f.account.admin = false
    if (change === 'preparation unavailable') f.unprepare()
    await expect(f.services.diagnostic('admin', f.candidate.name)).rejects.toMatchObject({ code })
    await expect(f.services.runtimeService('admin', f.candidate.name, true)).resolves.toBeUndefined()
    await f.shared.reconcile()
    expect(f.live).toBe(false)
  } finally {
    await f.shared.stop()
  }
})

it.each([false, true])('preserves a diagnostic carrier when current facts are uncertain (unknown=%s)', async unknown => {
  const f = fixture()
  try {
    await f.shared.connect('admin', await f.services.diagnostic('admin', f.candidate.name), true)
    const error = unknown ? new Error('Read failed') : new PlatformDatabaseError('unavailable', 'View is refreshing')
    f.fail(error)
    await expect(f.services.runtimeService('admin', f.candidate.name, true)).rejects.toBe(error)
    await expect(f.shared.reconcile()).rejects.toBeInstanceOf(unknown ? AggregateError : PlatformDatabaseError)
    expect(f.live).toBe(true)
  } finally {
    await f.shared.stop()
  }
})
