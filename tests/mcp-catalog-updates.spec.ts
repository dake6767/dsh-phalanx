import { expect, it } from 'vitest'
import { McpServices } from '../src/use-cases/mcp-services.js'
import type { McpState } from '../src/domain/mcp-service.js'
import type { McpPreset } from '../src/domain/mcp-catalog.js'

function fixture(runtime?: import('../src/ports/mcp-services.js').McpRuntimePort) {
  let state: McpState = { services: [], grants: {} }
  const accounts = [{ username: 'admin', spaceId: 'admin', admin: true, groupId: 'admins', disabled: false, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 }, { username: 'member', spaceId: 'member', admin: false, groupId: 'members', disabled: false, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 }]
  const presets: McpPreset[] = [{ entry: { id: 'amap', version: '1', title: { en: 'Fixture', 'zh-CN': '夹具' }, description: { en: 'Fixture', 'zh-CN': '夹具' }, credentialLabel: { en: 'Key', 'zh-CN': 'Key' }, location: 'remote', documentation: 'https://example.test', imported: 0 }, configuration: { description: 'Fixture', url: 'https://old.example.test', run: null, query: [{ name: 'key', value: '{credential}' }] } }]
  const create = () => new McpServices({ get: name => accounts.find(row => row.username === name), list: () => accounts, listGroups: () => [{ id: 'admins', name: 'Admins', kind: 'admin', isDefault: false, memberCount: 1 }, { id: 'members', name: 'Members', kind: 'ordinary', isDefault: true, memberCount: 1 }] }, { read: () => structuredClone(state), write: next => { state = structuredClone(next) } }, { synchronize: async () => {} }, runtime, presets)
  return { service: create(), create, presets, accounts, actor: { username: 'admin', spaceId: 'admin', sessionEpoch: 0 }, member: { username: 'member', spaceId: 'member', sessionEpoch: 0 } }
}
const input = { presetId: 'amap', name: 'p-map', credential: 'fixture-key', requestId: 'import-update-fixture-01' }
const update = { name: 'p-map', version: '2', requestId: 'catalog-update-request-01' }
async function ready(f: ReturnType<typeof fixture>) {
  await f.service.importCatalog(f.actor, input)
  await f.service.recordTest(f.actor, input.name, f.service.diagnostic('admin', input.name).generation, [{ name: 'weather', inputSchema: {} }])
  await f.service.grant(f.actor, 'members', [input.name])
  f.presets[0] = { ...f.presets[0]!, entry: { ...f.presets[0]!.entry, version: '2' }, configuration: { ...f.presets[0]!.configuration, url: 'https://new.example.test' } }
}
it('keeps the adopted remote service until candidate validation passes, then preserves current management state', async () => {
  const f = fixture(); await ready(f)
  const preview = f.service.catalogUpdatePreview(f.actor, input.name)
  expect(preview).toMatchObject({ version: '2', currentVersion: '1', credentialRequired: false })
  expect(JSON.stringify(preview)).not.toContain('fixture-key')
  const candidate = await f.service.beginCatalogUpdate(f.actor, update)
  expect(f.service.effective('member')[0]?.url).toBe('https://old.example.test')
  expect(await f.service.beginCatalogUpdate(f.actor, update)).toEqual(candidate)
  expect(f.service.diagnostic('admin', candidate.name).url).toBe('https://new.example.test')
  expect(f.service.effective('member').some(row => row.name === candidate.name)).toBe(false)
  await f.service.publish(f.actor, input.name, true)
  await f.service.toggle(f.member, input.name, false)
  await f.service.finishCatalogUpdate(f.actor, candidate.name, [{ name: 'weather', inputSchema: {} }, { name: 'route', inputSchema: {} }])
  expect(f.service.list(f.actor)[0]).toMatchObject({ name: 'p-map', catalog: { version: '2', status: 'ready' }, published: true, catalogUpdate: { status: 'applied' } })
  expect(f.service.effective('member')).toEqual([])
  await f.service.toggle(f.member, input.name, true)
  expect(f.service.effective('member')[0]).toMatchObject({ url: 'https://new.example.test', credential: 'fixture-key' })
})
it.each(['failure', 'restart', 'rotation', 'deletion', 'revocation'] as const)('never applies an obsolete candidate after %s', async change => {
  const f = fixture(); await ready(f)
  const candidate = await f.service.beginCatalogUpdate(f.actor, update)
  if (change === 'restart') await f.create().interruptCatalogTests()
  if (change === 'rotation') await f.service.save(f.actor, { ...f.service.list(f.actor)[0]!, credential: 'rotated-key' })
  if (change === 'deletion') await f.service.remove(f.actor, input.name)
  if (change === 'revocation') f.accounts[0]!.admin = false
  await f.service.finishCatalogUpdate(f.actor, candidate.name, change === 'failure' ? undefined : [{ name: 'stale', inputSchema: {} }]).catch(() => {})
  f.accounts[0]!.admin = true
  const row = f.service.list(f.actor)[0]
  if (change === 'deletion') expect(row).toBeUndefined()
  else { expect(row?.url).toBe('https://old.example.test'); expect(row?.catalog?.version).toBe('1') }
})

it('automatically probes an update once, records failure for retry, and keeps the original grant', async () => {
  const { McpCatalogImports } = await import('../src/use-cases/mcp-catalog-imports.js')
  const { McpConnectionTest } = await import('../src/use-cases/mcp-connection-test.js')
  const f = fixture(); await ready(f)
  let fail = true, calls = 0
  const probe = { probe: async () => { calls++; if (fail) throw Error('secret failure'); return [{ name: 'weather', inputSchema: {} }] } }
  const jobs = new McpCatalogImports(f.service, new McpConnectionTest(f.service, probe), probe)
  await jobs.update(f.actor, update); await jobs.drain()
  expect(f.service.list(f.actor)[0]).toMatchObject({ url: 'https://old.example.test', catalogUpdate: { status: 'failed' } })
  await jobs.update(f.actor, update); await jobs.drain(); expect(calls).toBe(1)
  fail = false
  await jobs.update(f.actor, { ...update, requestId: 'catalog-update-retry-02' }); await jobs.drain()
  expect(f.service.effective('member')[0]?.url).toBe('https://new.example.test')
  expect(calls).toBe(2); await jobs.stop()
})

it('reserves a candidate identity from manual saves and rejects missing newly required credentials', async () => {
  const f = fixture(); await ready(f)
  const candidate = await f.service.beginCatalogUpdate(f.actor, update)
  await expect(f.service.save(f.actor, { name: candidate.name, description: 'manual', url: 'https://manual.example.test' }, true)).rejects.toThrow()
  await expect(f.service.importCatalog(f.actor, { ...input, name: candidate.name, requestId: 'conflicting-import-request' })).rejects.toThrow()
  await f.service.failCatalogUpdate(candidate.name)
  await f.service.save(f.actor, { ...f.service.list(f.actor)[0]!, credential: '' })
  await f.service.recordTest(f.actor, input.name, f.service.list(f.actor)[0] ? f.service.diagnostic('admin', input.name).generation : 0, [])
  expect(f.service.catalogUpdatePreview(f.actor, input.name).credentialRequired).toBe(true)
  await expect(f.service.beginCatalogUpdate(f.actor, { ...update, requestId: 'missing-credential-request' })).rejects.toThrow()
})

it('keeps adopted preparation owners disjoint from later manual service names', async () => {
  const { sharedMcpExecution } = await import('../src/domain/mcp-execution.js')
  const f = fixture({ ready: row => ({ directory: '/prepared/' + (row.preparationName ?? row.name) }), view: () => ({ stage: 'ready', updatedAt: 0, log: '' }), changed: async () => {}, restart() {} })
  f.presets[0] = { ...f.presets[0]!, configuration: { description: 'Fixture', url: '', run: { location: 'shared', command: 'node', args: [], env: [], prepareCommand: 'fixture' } } }
  await ready(f)
  const candidate = await f.service.beginCatalogUpdate(f.actor, update)
  await f.service.finishCatalogUpdate(f.actor, candidate.name, [])
  const adopted = f.service.diagnostic('admin', input.name)
  await f.service.save(f.actor, { name: candidate.name, description: 'Manual', url: '', run: adopted.run ?? null }, true)
  const manual = f.service.diagnostic('admin', candidate.name)
  expect(sharedMcpExecution(adopted)?.owner.id).not.toBe(sharedMcpExecution(manual)?.owner.id)
})

it('removes obsolete credential mappings exactly as the validated candidate did', async () => {
  const f = fixture(); await ready(f)
  f.presets[0] = { ...f.presets[0]!, configuration: { description: 'Header service', url: 'https://new.example.test', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }] } }
  const candidate = await f.service.beginCatalogUpdate(f.actor, update)
  expect(f.service.diagnostic('admin', candidate.name).query ?? []).toEqual([])
  await f.service.finishCatalogUpdate(f.actor, candidate.name, [])
  expect(f.service.diagnostic('admin', input.name)).toMatchObject({ query: [], headers: [{ name: 'Authorization', value: 'Bearer {credential}' }], credential: 'fixture-key' })
})
