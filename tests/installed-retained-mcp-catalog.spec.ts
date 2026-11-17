import type { APIResponse } from 'playwright'
import { expect, it } from 'vitest'
import { seedRetainedMcpCatalog } from './support/installed-retained-mcp-catalog.js'

const name = 'p-retained-12306'
const row = (catalog: 'failed' | 'ready', preparation: 'failed' | 'ready') => ({
  name,
  catalog: { id: '12306', version: '1', status: catalog },
  preparation: { stage: preparation, log: '' },
  testStatus: catalog === 'ready' ? 'passed' : 'failed',
  credentialConfigured: false,
  tools: catalog === 'ready' ? [{ name: 'get-tickets' }] : [],
})

function fixture(initial: ReturnType<typeof row> | undefined, imported: ReturnType<typeof row>, retried = row('ready', 'ready')) {
  let installed = initial
  const actions: unknown[] = []
  const api = {
    groupId: 'member',
    get: async (path: string) => (path === 'mcp' ? (installed ? [installed] : []) : { revision: 'fixture' }),
    post: async (path: string, body: object) => {
      if (path !== 'mcp/catalog') return { status: () => 200 } as APIResponse
      const action = (body as { action: string }).action
      actions.push(action)
      installed = action === 'import' ? imported : retried
      return { status: () => 202 } as APIResponse
    },
  }
  return { api, actions }
}

it('records discovery failure before using the old release retry once', async () => {
  const old = fixture(undefined, row('failed', 'ready'))
  const result = await seedRetainedMcpCatalog(old.api)
  expect(old.actions).toEqual(['import', 'retry'])
  expect(result.discoveries.map(observation => observation.connection)).toEqual(['failed', 'passed'])
})

it('lets an explicit resume retry a failed preparation without another automatic retry', async () => {
  const old = fixture(row('failed', 'failed'), row('failed', 'failed'), row('failed', 'ready'))
  await expect(seedRetainedMcpCatalog(old.api)).rejects.toThrow()
  expect(old.actions).toEqual(['retry'])
})

it('keeps a fresh preparation failure visible without invoking discovery retry', async () => {
  const old = fixture(undefined, row('failed', 'failed'))
  await expect(seedRetainedMcpCatalog(old.api)).rejects.toThrow()
  expect(old.actions).toEqual(['import'])
})
