import { expect, it } from 'vitest'
import { McpConnectionTest } from '../src/use-cases/mcp-connection-test.js'
import { McpServices } from '../src/use-cases/mcp-services.js'
import type { McpState } from '../src/domain/mcp-service.js'
it('records discovered tools, new tools, failures and rejects stale results without blocking edits', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  const account = { ...actor, admin: true, disabled: false, email: '', groupId: 'admins', createdAt: 0, updatedAt: 0 }
  let state: McpState = { services: [], grants: {} }
  const services = new McpServices({ get: () => account, list: () => [account], listGroups: () => [] }, { read: () => structuredClone(state), write: next => { state = structuredClone(next) } }, { synchronize: async () => {} })
  const input = { name: 'p-docs', description: '', url: 'https://example.test/mcp' }
  await services.save(actor, input)
  const tool = (name: string) => ({ name, inputSchema: { type: 'object' } })
  const probe = new McpConnectionTest(services, { probe: async () => [tool('read')] })
  expect((await probe.execute(actor, input.name)).tools).toEqual([{ ...tool('read'), isNew: true }])
  const more = new McpConnectionTest(services, { probe: async () => [tool('read'), tool('new')] })
  expect((await more.execute(actor, input.name)).tools.map(row => row.isNew)).toEqual([false, true])
  const bad = new McpConnectionTest(services, { probe: async () => { throw Error('private detail') } })
  expect((await bad.execute(actor, input.name)).testStatus).toBe('failed')
  expect(services.list(actor)[0]?.tools).toHaveLength(2)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const racing = () => new McpConnectionTest(services, { probe: async () => { entered(); await gate; return [tool('stale')] } }).execute(actor, input.name)
  const pending = racing()
  await started; await services.save(actor, { ...input, url: 'https://new.example.test/mcp' }); release()
  await expect(pending).rejects.toThrow('changed')
  expect(services.list(actor)[0]).toMatchObject({ testStatus: 'untested', url: 'https://new.example.test/mcp' })
  state = { services: state.services, grants: state.grants } // Legacy schema before revisions were persisted.
  const original = services.diagnostic(actor.username, input.name).generation
  await services.remove(actor, input.name); await services.save(actor, input)
  await expect(services.recordTest(actor, input.name, original, [tool('deleted-service-tool')])).rejects.toThrow('changed')
  expect(services.list(actor)[0]?.testStatus).toBe('untested')
})
