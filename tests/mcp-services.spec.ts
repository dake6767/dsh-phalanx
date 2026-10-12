import { expect, it } from 'vitest'
import { McpServices } from '../src/use-cases/mcp-services.js'
import type { McpState } from '../src/domain/mcp-service.js'

function fixture() {
  let state: McpState = { services: [], grants: {} }
  const accounts = ['admin', 'member'].map(username => ({ username, spaceId: username, admin: username === 'admin', groupId: username === 'admin' ? 'admins' : 'members', disabled: false, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 }))
  const groups = [{ id: 'admins', name: 'Admins', kind: 'admin' as const, isDefault: false, memberCount: 1 }, { id: 'members', name: 'Members', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }]
  const projections: string[][] = []
  const service = new McpServices({ get: name => accounts.find(row => row.username === name), list: () => accounts, listGroups: () => groups },
    { read: () => structuredClone(state), write: next => { state = structuredClone(next) } }, { synchronize: async rows => { projections.push(rows.flatMap(row => row.services.map(item => row.username + ':' + item.name))) } })
  const actor = { username: 'admin', spaceId: 'admin', sessionEpoch: 0 }
  return { service, actor, accounts, projections }
}
it('grants only explicit ordinary group services, leaves implicit admin services off and revokes current access', async () => {
  const { service, actor, accounts, projections } = fixture()
  await service.save(actor, { name: 'p-docs', description: 'Documentation', url: 'https://mcp.example.test/mcp' })
  await expect(service.save(actor, { name: 'p-docs', description: 'Duplicate', url: 'https://other.example.test' }, true)).rejects.toThrow()
  expect(service.effective('member')).toEqual([])
  expect(service.group(actor, 'admins').services[0]).toMatchObject({ granted: true })
  expect(service.effective('admin')).toEqual([])
  await service.grant(actor, 'members', ['p-docs'])
  expect(service.effective('member').map(row => row.name)).toEqual(['p-docs'])
  expect(projections.at(-1)).toEqual(['member:p-docs'])
  await service.save(actor, { name: 'p-docs', description: 'Updated', url: 'https://updated.example.test/mcp' })
  expect(service.effective('member')[0]?.url).toBe('https://updated.example.test/mcp')
  await service.grant(actor, 'members', [])
  expect(service.effective('member')).toEqual([])
  await service.grant(actor, 'members', ['p-docs'])
  accounts[1]!.disabled = true
  expect(service.effective('member')).toEqual([])
  accounts[1]!.disabled = false
  await service.remove(actor, 'p-docs')
  expect(service.group(actor, 'members').services).toEqual([])
  await service.save(actor, { name: 'p-docs', description: '', url: 'https://mcp.example.test/mcp' })
  expect(service.effective('member')).toEqual([])
})
it('rejects stale actors, nonadmins, invalid names/URLs and nonexistent grants', async () => {
  const { service, actor } = fixture()
  for (const name of ['plain', 'p-', 'p-../x', 'p-' + 'a'.repeat(31)]) await expect(service.save(actor, { name, description: '', url: 'https://mcp.example.test/mcp' })).rejects.toThrow()
  for (const url of ['file:///tmp/mcp', 'https://secret@example.test/mcp', 'https://example.test/mcp#key']) await expect(service.save(actor, { name: 'p-docs', description: '', url })).rejects.toThrow()
  await expect(service.grant(actor, 'members', ['missing'])).rejects.toThrow()
  await expect(service.grant(actor, 'admins', [])).rejects.toThrow()
  await expect(service.save({ ...actor, sessionEpoch: 1 }, { name: 'p-docs', description: '', url: 'https://example.test' })).rejects.toThrow()
  expect(() => service.list({ username: 'member', spaceId: 'member', sessionEpoch: 0 })).toThrow()
})
it('drains queued projections before shutdown and rejects new work after stopping', async () => {
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const service = new McpServices({ get: () => undefined, list: () => [], listGroups: () => [] }, { read: () => ({ services: [], grants: {} }), write: () => {} }, { synchronize: async () => { entered(); await gate } })
  const recovering = service.recover(); await started
  let stopped = false
  const stopping = service.stop().then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false)
  await expect(service.recover()).rejects.toThrow()
  release(); await recovering; await stopping; expect(stopped).toBe(true)
})
it('never returns platform credentials and preserves them when only basic settings change', async () => {
  const { service, actor } = fixture()
  await service.save(actor, { name: 'p-secret', description: '', url: 'https://mcp.example.test', credential: 'platform-secret', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }], query: [{ name: 'key', value: '{credential}' }], disabledTools: ['write'] })
  expect(JSON.stringify(service.list(actor))).not.toContain('platform-secret')
  expect(JSON.stringify(service.group(actor, 'admins'))).not.toContain('platform-secret')
  expect(service.list(actor)[0]).toMatchObject({ credentialConfigured: true, disabledTools: ['write'], testStatus: 'untested' })
  await service.save(actor, { name: 'p-secret', description: 'Changed', url: 'https://mcp.example.test' })
  expect(service.diagnostic('admin', 'p-secret').credential).toBe('platform-secret')
  expect(() => service.diagnostic('member', 'p-secret')).toThrow()
  await service.save(actor, { name: 'p-secret', description: '', url: 'https://mcp.example.test', credential: '' })
  expect(service.list(actor)[0]?.credentialConfigured).toBe(false)
})
