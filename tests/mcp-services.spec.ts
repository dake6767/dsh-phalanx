import { expect, it } from 'vitest'
import { McpServices } from '../src/use-cases/mcp-services.js'
import type { McpState } from '../src/domain/mcp-service.js'

function fixture(runtime?: import('../src/ports/mcp-services.js').McpRuntimePort) {
  let state: McpState = { services: [], grants: {} }
  const accounts = ['admin', 'member'].map(username => ({ username, spaceId: username, admin: username === 'admin', groupId: username === 'admin' ? 'admins' : 'members', disabled: false, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 }))
  const groups = [{ id: 'admins', name: 'Admins', kind: 'admin' as const, isDefault: false, memberCount: 1 }, { id: 'members', name: 'Members', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }]
  const projections: string[][] = []
  const service = new McpServices({ get: name => accounts.find(row => row.username === name), list: () => accounts, listGroups: () => groups },
    { read: () => structuredClone(state), write: next => { state = structuredClone(next) } }, { synchronize: async rows => { projections.push(rows.flatMap(row => row.services.map(item => row.username + ':' + item.name))) } }, runtime)
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
it('centralizes grants, required services, administrator defaults and persistent market choices', async () => {
  const { service, actor, accounts } = fixture(), member = { username: 'member', spaceId: 'member', sessionEpoch: 0 }
  const input = { name: 'p-market', description: '', url: 'https://example.test/mcp' }
  await service.save(actor, input)
  await expect(service.publish(actor, input.name, true)).rejects.toThrow()
  await service.recordTest(actor, input.name, service.diagnostic('admin', input.name).generation, [{ name: 'read', inputSchema: {} }])
  await service.publish(actor, input.name, true)
  expect(service.market(member)[0]).toMatchObject({ granted: false, enabled: false })
  await service.toggle(member, input.name, true)
  expect(service.effective('member')).toHaveLength(1)
  await service.grant(actor, 'members', [input.name])
  await service.toggle(member, input.name, false)
  expect(service.effective('member')).toEqual([])
  await service.save(actor, { ...input, required: true })
  expect(service.effective('member')).toHaveLength(1)
  expect(service.effective('admin')).toHaveLength(1)
  await expect(service.toggle(member, input.name, false)).rejects.toThrow()
  await service.save(actor, { ...input, required: false })
  expect(service.effective('member')).toEqual([]); expect(service.effective('admin')).toEqual([])
  await service.publish(actor, input.name, false)
  expect(service.market(member)[0]).toMatchObject({ granted: true, enabled: false })
  await service.grant(actor, 'members', [])
  expect(service.market(member)).toEqual([])
  await service.publish(actor, input.name, true)
  expect(service.effective('member')).toEqual([])
  await service.toggle(member, input.name, true); await service.recover()
  expect(service.effective('member')).toHaveLength(1)
  await service.save(actor, { ...input, url: 'https://changed.example.test/mcp' })
  expect(service.market(member)[0]).toMatchObject({ enabled: true })
  expect(service.list(actor)[0]).toMatchObject({ published: true, testStatus: 'untested' })
  await service.recordTest(actor, input.name, service.diagnostic('admin', input.name).generation, undefined)
  expect(service.market(member)[0]).toMatchObject({ enabled: true })
  expect(service.list(actor)[0]).toMatchObject({ published: true, testStatus: 'failed' })
  await expect(service.publish(actor, input.name, true)).rejects.toThrow()
  await service.save(actor, { ...input, credential: 'rotated-fictional-key' })
  expect(service.effective('member')[0]?.credential).toBe('rotated-fictional-key')
  accounts[1]!.sessionEpoch++
  await expect(service.toggle(member, input.name, true)).rejects.toThrow()
  await service.remove(actor, input.name); await service.save(actor, input)
  expect(service.effective('member')).toEqual([])
})
it('stores imported runtime settings and write-only credentials while refusing to move credentials into members', async () => {
  const { service, actor } = fixture()
  const run = { location: 'shared' as const, command: 'node', args: ['server.js'], env: [{ name: 'API_KEY', value: '{credential}' }], prepareCommand: '' }
  await service.save(actor, { name: 'p-imported', description: '', url: '', run, credential: 'fictional-one', credentials: { second: 'fictional-two' } }, true)
  expect(JSON.stringify(service.list(actor))).not.toContain('fictional-')
  expect(service.list(actor)[0]).toMatchObject({ credentialConfigured: true, credentialNames: ['second'], run })
  await expect(service.save(actor, { name: 'p-imported', description: '', url: '', run: { ...run, location: 'member', env: [] } })).rejects.toThrow()
  await service.save(actor, { name: 'p-imported', description: '', url: '', credential: '', credentials: { second: '' }, run: { ...run, location: 'member', env: [] } })
  expect(service.list(actor)[0]).toMatchObject({ credentialConfigured: false, credentialNames: [] })
  expect(() => service.diagnostic('admin', 'p-imported')).toThrow()
})

it('renames a service atomically while retaining grants, secrets and member choices, and removal retires its identity', async () => {
  const { service, actor } = fixture(), member = { username: 'member', spaceId: 'member', sessionEpoch: 0 }
  const input = { name: 'p-old', description: 'Original', url: 'https://example.test/mcp', credential: 'fictional-secret' }
  await service.save(actor, input)
  await service.grant(actor, 'members', ['p-old'])
  await service.toggle(member, 'p-old', false)
  await service.save(actor, { name: 'p-new', description: 'Renamed', url: input.url }, false, 'p-old')
  expect(service.list(actor).map(row => row.name)).toEqual(['p-new'])
  expect(service.market(member)).toMatchObject([{ name: 'p-new', granted: true, enabled: false }])
  expect(service.diagnostic('admin', 'p-new').credential).toBe('fictional-secret')
  expect(() => service.diagnostic('admin', 'p-old')).toThrow()
  await service.toggle(member, 'p-new', true)
  expect(service.effective('member').map(row => row.name)).toEqual(['p-new'])
  await service.save(actor, { ...input, name: 'p-taken' })
  await expect(service.save(actor, { ...input, name: 'p-taken' }, false, 'p-new')).rejects.toThrow()
  expect(service.effective('member').map(row => row.name)).toEqual(['p-new'])
  await service.remove(actor, 'p-new')
  await service.save(actor, { ...input, name: 'p-new' })
  expect(service.market(member)).toEqual([])
  await service.grant(actor, 'members', ['p-new'])
  expect(service.effective('member').map(row => row.name)).toEqual(['p-new'])
  await expect(service.save(actor, { ...input, name: 'p-other' }, false, 'p-gone')).rejects.toThrow()
})

it('keeps market selections on rename and invalidates them on unpublish and removal', async () => {
  const { service, actor } = fixture(), member = { username: 'member', spaceId: 'member', sessionEpoch: 0 }
  const input = { name: 'p-first', description: '', url: 'https://example.test/mcp' }
  await service.save(actor, input)
  await service.recordTest(actor, input.name, service.diagnostic('admin', input.name).generation, [])
  await service.publish(actor, input.name, true)
  await service.toggle(member, input.name, true)
  await service.save(actor, { ...input, name: 'p-second' }, false, input.name)
  expect(service.effective('member').map(row => row.name)).toEqual(['p-second'])
  await service.publish(actor, 'p-second', false)
  expect(service.effective('member')).toEqual([])
  await service.publish(actor, 'p-second', true)
  expect(service.market(member)).toMatchObject([{ name: 'p-second', enabled: false }])
  await service.toggle(member, 'p-second', true)
  await service.remove(actor, 'p-second')
  await service.save(actor, { ...input, name: 'p-second' })
  await service.recordTest(actor, 'p-second', service.diagnostic('admin', 'p-second').generation, [])
  await service.publish(actor, 'p-second', true)
  expect(service.market(member)).toMatchObject([{ name: 'p-second', enabled: false }])
})

it('activates member stdio only for current prepared dependencies and exposes preparation state to administrators', async () => {
  let ready = false
  const { service, actor, projections } = fixture({
    ready: row => ready && row.run?.location === 'member' ? { directory: '/dependencies/frozen' } : undefined,
    view: () => ({ stage: ready ? 'ready' : 'preparing', updatedAt: 0, log: 'fixture preparation' }),
    changed: async () => {}, restart: () => {},
  })
  const input = { name: 'p-browser', description: '', url: '', run: { location: 'member' as const, command: 'browser-tool', args: [], env: [], prepareCommand: 'install-pinned' } }
  await service.save(actor, input); await service.grant(actor, 'members', [input.name])
  expect(service.effective('member')).toEqual([])
  expect(service.list(actor)[0]).toMatchObject({ preparation: { stage: 'preparing' } })
  ready = true; await service.recover()
  expect(service.effective('member')[0]).toMatchObject({ name: input.name, prepared: { directory: '/dependencies/frozen' } })
  expect(projections.at(-1)).toEqual(['member:p-browser'])
  expect(service.diagnostic('admin', input.name)).toMatchObject({ prepared: { directory: '/dependencies/frozen' } })
  await service.toggle({ username: 'member', spaceId: 'member', sessionEpoch: 0 }, input.name, false)
  expect(service.effective('member')).toEqual([])
  ready = false; await service.save(actor, { ...input, run: { ...input.run, prepareCommand: 'new-pinned' } })
  expect(() => service.diagnostic('admin', input.name)).toThrow(expect.objectContaining({ code: 'mcp-runtime-not-ready' }))
})

it('distributes member dependencies only after a service is granted or selected, and withdraws them with ownership', async () => {
  const version = { id: 'one', identity: 'one', directory: '/host/one', mountedPath: '/fixed/one', pathDirectories: ['bin'], commands: ['tool'], commandPaths: { tool: 'bin/tool' }, bytes: 1, isolated: true, checks: [], log: '' }
  const f = fixture({ ready: () => ({ directory: '/fixed/one', dependencies: [version] }), view: () => ({ stage: 'ready', updatedAt: 0, log: '' }), changed: async () => {}, restart: () => {} })
  await f.service.save(f.actor, { name: 'p-tools', description: '', url: '', run: { location: 'member', command: 'tool', args: [], env: [], runtimeDependencies: ['tool'] } })
  await f.service.recordTest(f.actor, 'p-tools', f.service.diagnostic('admin', 'p-tools').generation, [])
  await f.service.publish(f.actor, 'p-tools', true)
  expect(f.service.memberDependencies('member')).toEqual([])
  const member = { username: 'member', spaceId: 'member', sessionEpoch: 0 }
  await f.service.toggle(member, 'p-tools', true)
  expect(f.service.memberDependencies('member')).toEqual([version])
  await f.service.toggle(member, 'p-tools', false)
  expect(f.service.memberDependencies('member')).toEqual([])
  await f.service.grant(f.actor, 'members', ['p-tools']); await f.service.toggle(member, 'p-tools', false)
  expect(f.service.memberDependencies('member')).toEqual([version])
  await f.service.grant(f.actor, 'members', [])
  expect(f.service.memberDependencies('member')).toEqual([])
})
