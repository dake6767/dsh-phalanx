import { expect, it } from 'vitest'
import { McpConnectionTest } from '../src/use-cases/mcp-connection-test.js'
import { McpCatalogImports } from '../src/use-cases/mcp-catalog-imports.js'
import { McpServices } from '../src/use-cases/mcp-services.js'
import type { McpState } from '../src/domain/mcp-service.js'

function fixture(synchronize: () => Promise<void> = async () => {}) {
  let state: McpState = { services: [], grants: {} }
  const accounts = ['admin', 'member'].map(username => ({ username, spaceId: username, admin: username === 'admin', groupId: username === 'admin' ? 'admins' : 'members', disabled: false, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 }))
  const groups = [{ id: 'admins', name: 'Admins', kind: 'admin' as const, isDefault: false, memberCount: 1 }, { id: 'members', name: 'Members', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }]
  const store = { read: () => structuredClone(state), write: (next: McpState) => { state = structuredClone(next) } }
  const create = () => new McpServices({ get: name => accounts.find(row => row.username === name), list: () => accounts, listGroups: () => groups }, store, { synchronize })
  return { service: create(), create, actor: { username: 'admin', spaceId: 'admin', sessionEpoch: 0 }, accounts }
}
const input = { presetId: 'amap', name: 'p-map', credential: 'fixture-map-key', requestId: 'test-import-request-0001' }
it('imports a private preset once across refresh and restart, allows explicit copies and keeps deleted requests retired', async () => {
  const { service, create, actor } = fixture()
  await service.importCatalog(actor, input)
  const restarted = create()
  await restarted.importCatalog(actor, input)
  expect(restarted.list(actor)).toHaveLength(1)
  expect(restarted.list(actor)[0]).toMatchObject({ name: 'p-map', url: 'https://mcp.amap.com/mcp', catalog: { id: 'amap', version: '1', status: 'testing' }, query: [{ name: 'key', value: '{credential}' }], credentialConfigured: true, published: false })
  expect(JSON.stringify(restarted.list(actor))).not.toContain('fixture-map-key')
  expect(restarted.effective('admin')).toEqual([])
  expect(restarted.effective('member')).toEqual([])
  await expect(restarted.publish(actor, 'p-map', true)).rejects.toThrow()
  await restarted.importCatalog(actor, { ...input, name: 'p-map-copy', requestId: 'test-import-request-0002' })
  expect(restarted.catalog(actor)[0]).toMatchObject({ id: 'amap', imported: 2 })
  await restarted.remove(actor, 'p-map')
  await expect(restarted.importCatalog(actor, input)).rejects.toThrow()
  expect(restarted.list(actor).map(row => row.name)).toEqual(['p-map-copy'])
})
it('locks preset configuration at the service boundary without binding manually named services', async () => {
  const { service, actor } = fixture()
  await service.importCatalog(actor, input)
  const saved = service.list(actor)[0]!
  for (const changed of [{ url: 'https://other.example.test' }, { run: { location: 'shared' as const, command: 'node', args: [], env: [], prepareCommand: '' } }, { query: [{ name: 'key', value: 'real-key' }] }, { headers: [{ name: 'Authorization', value: 'Bearer {credential}' }] }, { description: 'Changed' }, { credentials: { extra: 'secret' } }]) {
    await expect(service.save(actor, { ...saved, ...changed })).rejects.toThrow()
  }
  await service.grant(actor, 'members', ['p-map'])
  expect(service.effective('member')).toEqual([])
  await service.recordTest(actor, 'p-map', service.diagnostic('admin', 'p-map').generation, [{ name: 'maps_weather', inputSchema: {} }])
  expect(service.effective('member')).toHaveLength(1)
  await service.save(actor, { ...service.list(actor)[0]!, name: 'p-renamed', credential: 'rotated-key', disabledTools: ['maps_weather'] }, false, 'p-map')
  expect(service.list(actor)[0]).toMatchObject({ name: 'p-renamed', catalog: { id: 'amap', status: 'failed' }, testStatus: 'untested', disabledTools: ['maps_weather'] })
  expect(service.effective('member')).toEqual([])
  await service.importCatalog(actor, input)
  expect(service.list(actor)).toHaveLength(1)
  await service.save(actor, { name: 'p-amap', description: 'Manual', url: 'https://custom.example.test' })
  await service.save(actor, { name: 'p-amap', description: 'Manual', url: 'https://changed.example.test' })
  expect(service.list(actor).find(row => row.name === 'p-amap')?.catalog).toBeUndefined()
})

it('automatically tests imports, exposes durable progress and retries a failure without another service', async () => {
  const { service, create, actor } = fixture()
  let release!: () => void, entered!: () => void, failing = true
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const imports = new McpCatalogImports(service, new McpConnectionTest(service, { probe: async () => { entered(); await gate; if (failing) throw Error('secret upstream detail'); return [{ name: 'maps_weather', inputSchema: {} }] } }))
  await imports.import(actor, input)
  await started
  expect(create().list(actor)[0]?.catalog?.status).toBe('testing')
  release(); await imports.drain()
  expect(service.list(actor)[0]).toMatchObject({ catalog: { status: 'failed' }, testStatus: 'failed' })
  await expect(service.publish(actor, input.name, true)).rejects.toThrow()
  failing = false
  await imports.retry(actor, input.name); await imports.drain()
  expect(service.list(actor)).toHaveLength(1)
  expect(service.list(actor)[0]).toMatchObject({ catalog: { status: 'ready' }, testStatus: 'passed' })
  expect(service.effective('admin')).toEqual([])
})
it('invalidates in-flight results after rotation, deletion and administrator revocation and recovers interruption', async () => {
  const { service, create, actor, accounts } = fixture()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const imports = new McpCatalogImports(service, new McpConnectionTest(service, { probe: async () => { entered(); await gate; return [{ name: 'stale', inputSchema: {} }] } }))
  await imports.import(actor, input); await started
  await service.save(actor, { ...service.list(actor)[0]!, credential: 'new-key' })
  release(); await imports.drain()
  expect(service.list(actor)[0]).toMatchObject({ catalog: { status: 'failed' }, testStatus: 'untested', tools: [] })
  await service.beginCatalogTest(actor, input.name)
  const restarted = create(); await restarted.interruptCatalogTests()
  expect(restarted.list(actor)[0]?.catalog?.status).toBe('failed')
  await service.remove(actor, input.name)
  await imports.retry(actor, input.name).catch(() => undefined)
  expect(service.list(actor)).toEqual([])
  await service.importCatalog(actor, { ...input, requestId: 'another-import-request' })
  accounts[0]!.admin = false
  await expect(imports.retry(actor, input.name)).rejects.toThrow()
  accounts[0]!.admin = true
  expect(service.list(actor)[0]?.catalog?.status).toBe('testing')
})

it('makes a persisted import retryable when projection fails before its probe can start', async () => {
  let failing = true
  const { service, actor } = fixture(async () => { if (failing) throw Error('projection unavailable') })
  const imports = new McpCatalogImports(service, new McpConnectionTest(service, { probe: async () => [{ name: 'weather', inputSchema: {} }] }))
  await expect(imports.import(actor, input)).rejects.toThrow()
  expect(service.list(actor)[0]?.catalog?.status).toBe('failed')
  failing = false
  await imports.retry(actor, input.name); await imports.drain()
  expect(service.list(actor)[0]?.catalog?.status).toBe('ready')
})
it('makes a persisted import retryable when its administrator is revoked during projection', async () => {
  let revoke = () => {}
  const { service, actor, accounts } = fixture(async () => { revoke() })
  revoke = () => { accounts[0]!.admin = false }
  const imports = new McpCatalogImports(service, new McpConnectionTest(service, { probe: async () => [{ name: 'weather', inputSchema: {} }] }))
  await imports.import(actor, input); await imports.drain()
  accounts[0]!.admin = true
  expect(service.list(actor)[0]?.catalog?.status).toBe('failed')
})
