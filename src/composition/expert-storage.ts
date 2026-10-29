import type { PlatformDatabase } from '../adapters/platform-database.js'
import type { ExpertRepositories } from '../ports/experts.js'
import { PostgresUnitOfWork } from '../adapters/postgres-unit-of-work.js'
import { PostgresExpertRows } from '../adapters/postgres-expert-rows.js'
import { PostgresExpertPolicies } from '../adapters/postgres-expert-policies.js'
import { PostgresExpertMetadata } from '../adapters/postgres-expert-metadata.js'
import { PostgresExpertStateQuery } from '../adapters/postgres-expert-state-query.js'
import { PostgresExpertFacts } from '../adapters/postgres-expert-facts.js'
import { ExpertDesiredState } from '../use-cases/expert-desired-state.js'
import { PostgresExpertReferences } from '../adapters/postgres-expert-references.js'

export function createExpertStorage(database: PlatformDatabase) {
  const facts = new PostgresExpertFacts(database)
  const work = new PostgresUnitOfWork<ExpertRepositories>(database, {
    experts: tx => new PostgresExpertRows(tx),
    grants: tx => new PostgresExpertPolicies(tx, 'group'),
    selections: tx => new PostgresExpertPolicies(tx, 'member'),
    metadata: tx => new PostgresExpertMetadata(tx),
  })
  const state = new ExpertDesiredState(new PostgresExpertStateQuery(database), work, facts)
  return Object.assign(state, {
    references: new PostgresExpertReferences(database),
    initialize: () => facts.initialize(),
    close: async () => {
      await state.stop()
      await facts.close()
    },
  })
}
