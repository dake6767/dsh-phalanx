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

it('prepares shared MCP credentials privately and invalidates readiness when a credential rotates', async () => {
  const input: McpService = { name: 'p-search', description: '', url: '', generation: 1, credentials: { key: 'fixture-key' }, run: { location: 'shared', command: 'search', args: [], env: [{ name: 'API_KEY', value: '{credential:key}' }], prepareCommand: 'install-pinned' } }
  let state: McpState = { services: [input], grants: {} }
  const records = new Map<string, ExecutionPreparationRecord>()
  const configurations: unknown[] = []
  const runtime = new McpRuntimePreparation({ read: () => state }, {
    retain() {}, list: () => [...records.values()], get: id => records.get(id), save: (id, row) => { records.set(id, row) },
  }, {
    directory: id => '/private/' + id, recover: async () => {}, collect: async () => {}, identity: owner => owner.version,
    prepare: async (owner, config) => { configurations.push(config); return { id: 'a'.repeat(64), hash: 'b'.repeat(64), version: owner.version, log: '' } },
  }, { now: () => 0 }, async () => {}, 'shared')
  try {
    await runtime.recover(); runtime.start()
    await expect.poll(() => runtime.view(input)?.stage).toBe('ready')
    expect(runtime.ready(input)?.directory).toBe('/private/' + 'a'.repeat(64))
    expect(configurations).toContainEqual(expect.objectContaining({ variables: [{ name: 'API_KEY', value: 'fixture-key', secret: true }] }))
    state = { ...state, services: [{ ...input, credentials: { key: 'rotated-fixture' } }] }
    expect(runtime.ready(state.services[0]!)).toBeUndefined()
  } finally { await runtime.stop() }
})

it.each(['member', 'shared'] as const)('withholds %s MCP readiness after a runtime identity change and refreshes only after new preparation', async location => {
  const input: McpService = { name: 'p-retained', description: '', url: '', generation: 1, run: { location, command: 'node', args: [], env: [], prepareCommand: 'prepare-for-runtime' } }
  const state: McpState = { services: [input], grants: { ordinary: [input.name] }, selections: { member: [input.name] } }
  const records = new Map<string, ExecutionPreparationRecord>()
  let image = 'old-runtime', finish!: () => void, calls = 0, refreshes = 0
  let barrier = Promise.resolve()
  const create = () => new McpRuntimePreparation({ read: () => state }, {
    retain() {}, list: () => [...records.values()], get: id => records.get(id), save: (id, row) => { records.set(id, row) },
  }, {
    directory: id => '/prepared/' + id, recover: async () => {}, collect: async () => {}, identity: owner => owner.version + image,
    prepare: async owner => { calls++; await barrier; return { id: image, hash: image, version: owner.version, log: '' } },
  }, { now: () => 0 }, async () => { refreshes++ }, location)
  const old = create(); await old.recover(); old.start()
  await expect.poll(() => old.ready(input)?.directory).toBe('/prepared/old-runtime')
  await old.stop(); expect(calls).toBe(1)
  image = 'new-runtime'; barrier = new Promise<void>(resolve => { finish = resolve })
  const upgraded = create()
  try {
    await upgraded.recover(); expect(upgraded.ready(input)).toBeUndefined()
    upgraded.start(); await expect.poll(() => calls).toBe(2)
    expect(upgraded.ready(input)).toBeUndefined(); expect(refreshes).toBe(1)
    finish(); await expect.poll(() => upgraded.ready(input)?.directory).toBe('/prepared/new-runtime')
    expect(refreshes).toBe(2)
    expect(state.grants).toEqual({ ordinary: ['p-retained'] }); expect(state.selections).toEqual({ member: ['p-retained'] })
  } finally { finish(); await upgraded.stop() }
})
