import { expect } from 'vitest'
import type { PlatformDatabase } from '../../src/adapters/platform-database.js'
import { PostgresCommunityAccountStore } from '../../src/adapters/postgres-community-accounts.js'
import { createMcpStorage } from '../../src/composition/mcp-storage.js'
import { McpServices } from '../../src/use-cases/mcp-services.js'
import { McpCatalogImports } from '../../src/use-cases/mcp-catalog-imports.js'
import { McpConnectionTest } from '../../src/use-cases/mcp-connection-test.js'

/** Real account/state persistence, with only the remote paid credential probe replaced. */
export async function restoreResetCatalog(database: PlatformDatabase): Promise<void> {
  const accounts = new PostgresCommunityAccountStore(database),
    store = createMcpStorage(database)
  await store.initialize()
  const account = (await accounts.get('admin'))!,
    actor = { username: account.username, spaceId: account.spaceId, sessionEpoch: account.sessionEpoch }
  const services = new McpServices(accounts, store, { synchronize: async () => {} })
  const probe = {
    probe: async (_username: string, _space: string, name: string) => {
      expect(await services.diagnostic('admin', name)).toMatchObject({ url: 'https://mcp.amap.com/mcp', credential: 'fictional-reconfigured-key' })
      return [{ name: 'weather', inputSchema: {} }]
    },
  }
  const jobs = new McpCatalogImports(services, new McpConnectionTest(services, probe), probe)
  try {
    const grants = (await store.read()).grants
    expect((await store.read()).services[0]?.catalogUpdate?.candidate).toBeUndefined()
    expect((await services.list(actor))[0]).toMatchObject({ availableCatalogVersion: '1', credentialConfigured: false })
    await jobs.update(actor, { name: 'p-service', version: '1', requestId: 'restore-reset-catalog-01', credential: 'fictional-reconfigured-key' })
    await jobs.drain()
    expect((await store.read()).services[0]).toMatchObject({
      name: 'p-service',
      catalog: { id: 'amap', version: '1', status: 'ready' },
      testStatus: 'passed',
      credential: 'fictional-reconfigured-key',
    })
    expect((await store.read()).services[0]?.configurationRequired).toBeUndefined()
    expect((await store.read()).grants).toEqual(grants)
  } finally {
    await jobs.stop()
    await services.stop()
    await store.close()
  }
}
