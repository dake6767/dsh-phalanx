import { expect, it } from 'vitest'
import { McpRuntimePreparation } from '../src/use-cases/mcp-runtime-preparation.js'
import type { McpService, McpState } from '../src/domain/mcp-service.js'
import type { ExecutionPreparationRecord } from '../src/domain/execution-preparation.js'

it('prepares a credential-free MCP owner once, invalidates changed inputs and refreshes projections on completion', async () => {
  const input: McpService = { name: 'p-browser', description: '', url: '', generation: 1, run: { location: 'member', command: 'browser', args: [], env: [], prepareCommand: 'pinned-install' } }
  let state: McpState = { services: [input], grants: {} }, calls = 0, refreshed = 0
  const records = new Map<string, ExecutionPreparationRecord>()
  const runtime = new McpRuntimePreparation({ read: () => state }, {
    retain: ids => { for (const id of records.keys()) if (!ids.includes(id)) records.delete(id) }, list: () => [...records.values()], get: id => records.get(id), save: (id, record) => { records.set(id, record) },
  }, {
    directory: id => '/prepared/' + id, recover: async () => {}, collect: async () => {}, identity: (owner, config) => owner.version + config.prepare,
    prepare: async owner => { calls++; return { id: 'f'.repeat(64), hash: 'f'.repeat(64), version: owner.version, log: 'pinned dependency ready' } },
  }, { now: () => 0 }, async () => { refreshed++ })
  await runtime.recover(); expect(runtime.ready(input)).toBeUndefined()
  runtime.start(); await expect.poll(() => runtime.view(input)?.stage).toBe('ready')
  expect(runtime.ready(input)).toEqual({ directory: '/prepared/' + 'f'.repeat(64) }); expect(calls).toBe(1); expect(refreshed).toBe(1)
  await runtime.changed(); expect(calls).toBe(1)
  const next = { ...input, run: { ...input.run!, prepareCommand: 'new-pinned' } }
  state = { ...state, services: [next] }; expect(runtime.ready(next)).toBeUndefined(); await runtime.changed()
  await expect.poll(() => runtime.view(next)?.stage).toBe('ready'); expect(calls).toBe(2)
  state = { ...state, services: [] }; await runtime.changed(); expect(runtime.ready(input)).toBeUndefined()
  await runtime.stop()
})

it('does not make dependency removal wait on a projection queued behind the removing mutation', async () => {
  const input: McpService = { name: 'p-browser', description: '', url: '', generation: 1, run: { location: 'member', command: 'browser', args: [], env: [], prepareCommand: '' } }
  let state: McpState = { services: [input], grants: {} }, finish!: () => void, refresh!: () => void, entered!: () => void
  const prepared = new Promise<void>(resolve => { finish = resolve }), notification = new Promise<void>(resolve => { refresh = resolve }), notified = new Promise<void>(resolve => { entered = resolve })
  const records = new Map<string, ExecutionPreparationRecord>()
  const runtime = new McpRuntimePreparation({ read: () => state }, {
    retain: ids => { for (const id of records.keys()) if (!ids.includes(id)) records.delete(id) }, list: () => [...records.values()], get: id => records.get(id), save: (id, record) => { records.set(id, record) },
  }, {
    directory: id => '/prepared/' + id, recover: async () => {}, collect: async () => {}, identity: owner => owner.version,
    prepare: async owner => { await prepared; return { id: 'f'.repeat(64), hash: 'f'.repeat(64), version: owner.version, log: '' } },
  }, { now: () => 0 }, async () => { entered(); await notification })
  runtime.start(); state = { ...state, services: [] }
  const removed = runtime.changed(); finish(); await notified
  try { await removed; expect(runtime.ready(input)).toBeUndefined() }
  finally { refresh(); await runtime.stop() }
})
