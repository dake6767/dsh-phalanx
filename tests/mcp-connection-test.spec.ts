import { asyncMcpFacts } from './fixtures/async-mcp-facts.js'
import { expect, it } from 'vitest'
import { McpConnectionTest } from '../src/use-cases/mcp-connection-test.js'
import { McpServices } from '../src/use-cases/mcp-services.js'
import type { McpState } from '../src/domain/mcp-service.js'
it('records discovered tools, new tools, failures and rejects stale results without blocking edits', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  const account = { ...actor, admin: true, disabled: false, email: '', groupId: 'admins', createdAt: 0, updatedAt: 0 }
  let state: McpState = { services: [], grants: {} }
  const services = new McpServices(
    { get: async () => account, list: async () => [account], listGroups: async () => [] },
    asyncMcpFacts({
      read: () => structuredClone(state),
      write: async next => {
        state = structuredClone(next)
      },
    }),
    { synchronize: async () => {} },
  )
  const input = { name: 'p-docs', description: '', url: 'https://example.test/mcp' }
  await services.save(actor, input)
  const tool = (name: string) => ({ name, inputSchema: { type: 'object' } })
  const probe = new McpConnectionTest(services, { probe: async () => [tool('read')] })
  expect((await probe.execute(actor, input.name)).tools).toEqual([{ ...tool('read'), isNew: true }])
  const more = new McpConnectionTest(services, { probe: async () => [tool('read'), tool('new')] })
  expect((await more.execute(actor, input.name)).tools.map(row => row.isNew)).toEqual([false, true])
  const bad = new McpConnectionTest(services, {
    probe: async () => {
      throw Error('private detail')
    },
  })
  expect((await bad.execute(actor, input.name)).testStatus).toBe('failed')
  expect((await services.list(actor))[0]?.tools).toHaveLength(2)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    started = new Promise<void>(resolve => {
      entered = resolve
    })
  const racing = () =>
    new McpConnectionTest(services, {
      probe: async () => {
        entered()
        await gate
        return [tool('stale')]
      },
    }).execute(actor, input.name)
  const pending = racing()
  await started
  await services.save(actor, { ...input, url: 'https://new.example.test/mcp' })
  release()
  await expect(pending).rejects.toThrow('changed')
  expect((await services.list(actor))[0]).toMatchObject({ testStatus: 'untested', url: 'https://new.example.test/mcp' })
  state = { services: state.services, grants: state.grants } // Legacy schema before revisions were persisted.
  const original = (await services.diagnostic(actor.username, input.name)).generation
  await services.remove(actor, input.name)
  await services.save(actor, input)
  await expect(services.recordTest(actor, input.name, original, [tool('deleted-service-tool')])).rejects.toThrow('changed')
  expect((await services.list(actor))[0]?.testStatus).toBe('untested')
})

it('discovers member-container tools through the prepared member path without enabling the administrator service', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 },
    account = { ...actor, admin: true, disabled: false, email: '', groupId: 'admins', createdAt: 0, updatedAt: 0 }
  let state: McpState = { services: [], grants: {} },
    memberCalls = 0
  const services = new McpServices(
    { get: async () => account, list: async () => [account], listGroups: async () => [] },
    asyncMcpFacts({
      read: () => state,
      write: async next => {
        state = next
      },
    }),
    { synchronize: async () => {} },
    { ready: () => ({ directory: '/prepared' }), view: () => undefined, changed: async () => {}, restart: () => {} },
  )
  await services.save(actor, {
    name: 'p-browser',
    description: '',
    url: '',
    run: { location: 'member', command: 'browser', args: [], env: [], prepareCommand: 'pinned-install' },
  })
  const test = new McpConnectionTest(
    services,
    {
      probe: async () => {
        throw Error('member service must not use HTTP upstream')
      },
    },
    {
      probe: async () => {
        memberCalls++
        return [{ name: 'browser_read', inputSchema: { type: 'object' } }]
      },
    },
  )
  expect((await test.execute(actor, 'p-browser')).testStatus).toBe('passed')
  expect(memberCalls).toBe(1)
  expect(await services.effective('admin')).toEqual([])
})
