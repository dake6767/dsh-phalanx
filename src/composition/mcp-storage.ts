import type { PlatformDatabase } from '../adapters/platform-database.js'
import { PostgresMcpStore } from '../adapters/postgres-mcp-store.js'
import { PostgresMcpPolicies } from '../adapters/postgres-mcp-policies.js'
import { PostgresMcpMetadata } from '../adapters/postgres-mcp-metadata.js'
import { PostgresMcpStateQuery } from '../adapters/postgres-mcp-state-query.js'
import { PostgresMcpFacts } from '../adapters/postgres-mcp-facts.js'
import { PostgresRuntimeDependencyStore } from '../adapters/postgres-runtime-dependencies.js'
import { PostgresUnitOfWork } from '../adapters/postgres-unit-of-work.js'
import type { McpRepositories } from '../ports/mcp-services.js'
import { McpDesiredState } from '../use-cases/mcp-desired-state.js'
import { PostgresExpertReferences } from '../adapters/postgres-expert-references.js'

/** One policy publication owner; transaction-bound repositories record each application diff. */
export function createMcpStorage(database: PlatformDatabase) {
  const facts = new PostgresMcpFacts(database)
  const work = new PostgresUnitOfWork<McpRepositories>(database, {
    services: tx => new PostgresMcpStore(tx),
    policies: tx => new PostgresMcpPolicies(tx),
    metadata: tx => new PostgresMcpMetadata(tx),
    runtime: tx => new PostgresRuntimeDependencyStore(tx),
    expertReferences: tx => new PostgresExpertReferences(tx),
  })
  const state = new McpDesiredState(new PostgresMcpStateQuery(database), work, facts)
  return Object.assign(state, {
    expertReferences: new PostgresExpertReferences(database),
    initialize: () => facts.initialize(),
    close: async () => {
      await state.stop()
      await facts.close()
    },
  })
}
