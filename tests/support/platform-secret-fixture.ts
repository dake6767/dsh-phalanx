import { seedMcpParents } from '../fixtures/mcp-parents.js'
import { seedExecutionOwners } from '../fixtures/execution-owners.js'
import type { PlatformDatabase } from '../../src/adapters/platform-database.js'
import { PostgresContributionSetups } from '../../src/adapters/postgres-contribution-setups.js'
import { PostgresExecutionConfigurations } from '../../src/adapters/postgres-execution-configurations.js'
import { createMcpStorage } from '../../src/composition/mcp-storage.js'
import { PostgresPluginAccessStore } from '../../src/adapters/postgres-plugin-access-store.js'
import { PostgresPluginUpstreams } from '../../src/adapters/postgres-plugin-upstreams.js'
import { PostgresSharedModelStore } from '../../src/adapters/postgres-shared-model-store.js'
import { FileSharedModelProjection } from '../../src/adapters/shared-model-projection.js'
import type { McpService } from '../../src/domain/mcp-service.js'
import { seedPluginParents } from './plugin-facts.js'

/** Nonempty current, nested candidate, receipt and checkpoint secret owners for whole-platform transfer. */
export async function seedPlatformSecretFixture(database: PlatformDatabase, data: string): Promise<void> {
  const models = new PostgresSharedModelStore(database, new FileSharedModelProjection(data))
  const upstreams = new PostgresPluginUpstreams(database),
    execution = new PostgresExecutionConfigurations(database),
    mcp = createMcpStorage(database),
    access = new PostgresPluginAccessStore(database),
    setups = new PostgresContributionSetups(database)
  try {
    await seedMcpParents(database, { groups: ['team'] })
    await seedPluginParents(database)
    await seedExecutionOwners(database, ['skill:example'])
    await Promise.all([models.initialize(), upstreams.initialize(), execution.initialize(), mcp.initialize(), access.initialize(), setups.initialize()])
    await models.save({
      revision: models.read().revision + 1,
      defaultModelId: 'fixture',
      providers: [
        {
          id: 'provider',
          name: 'Retained provider',
          apiFormat: 'anthropic-messages',
          baseUrl: 'https://models.example.test',
          apiKey: 'fictional-reset-secret',
          enabled: true,
          models: [{ id: 'fixture', name: 'Fixture', enabled: true, input: 'text' }],
        },
      ],
    })
    await upstreams.save('plugin', [
      {
        name: 'search',
        baseUrl: 'https://search.example.test',
        credential: 'fictional-upstream-key',
        headers: [{ name: 'X-Key', value: 'fictional-upstream-header' }],
        testRequest: { method: 'POST', path: '/check?key=fictional-query-key', body: { key: 'fictional-body-key' } },
      },
    ])
    await execution.save('skill:example', {
      enabled: true,
      commands: [{ command: 'scripts/run.py', blocked: [] }],
      variables: [
        { name: 'PRIVATE_KEY', value: 'fictional-variable-key', secret: true },
        { name: 'REGION', value: 'retained-region', secret: false },
      ],
    })
    const candidate: McpService = {
      name: 'p-service',
      generation: 2,
      description: 'Retained service',
      url: 'https://mcp.example.test/fictional-mcp-key',
      credential: 'fictional-mcp-key',
      credentials: { account: 'fictional-account-key' },
      headers: [{ name: 'X-Key', value: 'fictional-mcp-header' }],
      query: [{ name: 'token', value: 'fictional-mcp-query' }],
      run: {
        location: 'shared',
        command: 'fictional-mcp-key',
        args: ['fictional-account-key'],
        env: [{ name: 'KEY', value: 'fictional-mcp-env' }],
        prepareCommand: 'fictional-mcp-key',
      },
    }
    await mcp.update(await mcp.read(), {
      services: [
        {
          ...candidate,
          run: null,
          generation: 3,
          catalogUpdate: {
            name: 'p-service',
            requestId: 'request',
            version: 'next',
            baseGeneration: 2,
            actor: { username: 'admin', spaceId: 'space', sessionEpoch: 0 },
            status: 'failed',
            candidate: {
              ...candidate,
              catalogUpdate: {
                name: 'p-service',
                requestId: 'nested',
                version: 'later',
                baseGeneration: 1,
                actor: { username: 'admin', spaceId: 'space', sessionEpoch: 0 },
                status: 'failed',
                candidate,
              },
            },
          },
        },
      ],
      grants: { team: ['p-service'] },
    })
    const before = {
      environment: [{ name: 'KEY', value: 'fictional-before-key' }],
      entriesYaml: 'main:\n  key: fictional-before-key',
      entries: { main: { key: 'fictional-before-key', enabled: true, nested: ['fictional-before-key', 7] } },
    }
    await access.save('plugin', before, { id: 'contribution', revision: 'receipt' })
    await access.applySuite('plugin', 'suite-task', { ...before, environment: [{ name: 'KEY', value: 'fictional-current-key' }] })
    await setups.save(
      { id: 'setup', revision: 'revision' },
      { execution: { enabled: true, commands: [], variables: [{ name: 'KEY', value: 'fictional-setup-key', secret: true }] } },
    )
  } finally {
    await Promise.all([models.close(), upstreams.close(), execution.close(), mcp.close(), access.close(), setups.close()])
  }
}
