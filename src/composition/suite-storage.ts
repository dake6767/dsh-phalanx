import { PostgresSuiteLocks } from '../adapters/postgres-suite-locks.js'
import { PostgresPluginLibraryStore } from '../adapters/postgres-plugin-library.js'
import { PostgresPluginGrants } from '../adapters/postgres-plugin-grants.js'
import { PostgresPluginSelections } from '../adapters/postgres-plugin-selections.js'
import { PostgresPluginAccessStore } from '../adapters/postgres-plugin-access-store.js'
import { PostgresPluginUpstreams } from '../adapters/postgres-plugin-upstreams.js'
import type { PlatformDatabase } from '../adapters/platform-database.js'
import { PostgresUnitOfWork } from '../adapters/postgres-unit-of-work.js'
import { PostgresContributionActors } from '../adapters/postgres-contribution-actors.js'
import { PostgresSkillLibraryStore } from '../adapters/postgres-skill-library.js'
import { PostgresSkillPackStore } from '../adapters/postgres-skill-packs.js'
import { PostgresSkillAssignments } from '../adapters/postgres-skill-assignments.js'
import { PostgresExecutionConfigurations } from '../adapters/postgres-execution-configurations.js'
import { PostgresRuntimeDependencyStore } from '../adapters/postgres-runtime-dependencies.js'
import { PostgresExpertReferences } from '../adapters/postgres-expert-references.js'

import { PostgresCatalogInstalls, PostgresCatalogRequests } from '../adapters/postgres-catalog-records.js'
import { PostgresRuntimeReferences } from '../adapters/postgres-runtime-references.js'
import type { SuiteRepositories } from '../ports/suite-unit-of-work.js'

/** External preparation finishes before this shared transaction is opened. */
export function createSuiteStorage(database: PlatformDatabase) {
  return {
    expertReferences: new PostgresExpertReferences(database),
    installs: new PostgresCatalogInstalls(database),
    requests: new PostgresCatalogRequests(database),
    work: new PostgresUnitOfWork<SuiteRepositories>(database, {
      locks: tx => new PostgresSuiteLocks(tx),
      plugins: tx => new PostgresPluginLibraryStore(tx),
      pluginGrants: tx => new PostgresPluginGrants(tx),
      pluginSelections: tx => new PostgresPluginSelections(tx),
      pluginAccess: tx => new PostgresPluginAccessStore(tx),
      pluginUpstreams: tx => new PostgresPluginUpstreams(tx),
      accounts: tx => new PostgresContributionActors(tx),
      library: tx => new PostgresSkillLibraryStore(tx),
      packs: tx => ({
        store: new PostgresSkillPackStore(tx),
        grants: new PostgresSkillAssignments(tx, 'packs', 'grants'),
        selections: new PostgresSkillAssignments(tx, 'packs', 'selections'),
      }),
      grants: tx => new PostgresSkillAssignments(tx, 'skills', 'grants'),
      selections: tx => new PostgresSkillAssignments(tx, 'skills', 'selections'),
      execution: tx => new PostgresExecutionConfigurations(tx),
      runtime: tx => new PostgresRuntimeDependencyStore(tx),
      expertReferences: tx => new PostgresExpertReferences(tx),
      runtimeReferences: tx => new PostgresRuntimeReferences(tx),
      installs: tx => new PostgresCatalogInstalls(tx),
      requests: tx => new PostgresCatalogRequests(tx),
    }),
  }
}
