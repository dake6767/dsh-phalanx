import { PostgresContributionSubmission } from '../adapters/postgres-contribution-submission.js'
import { PostgresContributionSkillImpact } from '../adapters/postgres-contribution-skill-impact.js'
import { PostgresPluginLibraryStore } from '../adapters/postgres-plugin-library.js'
import { PostgresPluginGrants } from '../adapters/postgres-plugin-grants.js'
import { PostgresPluginSelections } from '../adapters/postgres-plugin-selections.js'
import { PostgresPluginAccessStore } from '../adapters/postgres-plugin-access-store.js'
import { PostgresPluginUpstreams } from '../adapters/postgres-plugin-upstreams.js'
import { YamlPluginAccessSyntax } from '../adapters/plugin-access-syntax.js'
import { ContributionTransactions } from '../use-cases/contribution-transactions.js'
import type { PlatformDatabase } from '../adapters/platform-database.js'
import { PostgresUnitOfWork } from '../adapters/postgres-unit-of-work.js'
import { PostgresContributionRows } from '../adapters/postgres-contribution-rows.js'
import { PostgresContributionActors } from '../adapters/postgres-contribution-actors.js'
import { PostgresSkillLibraryStore } from '../adapters/postgres-skill-library.js'
import { PostgresSkillPackStore } from '../adapters/postgres-skill-packs.js'
import { PostgresSkillAssignments } from '../adapters/postgres-skill-assignments.js'
import { PostgresExecutionConfigurations } from '../adapters/postgres-execution-configurations.js'
import { PostgresRuntimeDependencyStore } from '../adapters/postgres-runtime-dependencies.js'
import { PostgresExpertReferences } from '../adapters/postgres-expert-references.js'
import type { ContributionRepositories } from '../ports/contribution-unit-of-work.js'

/** All adoption repositories share their caller's one SQL transaction. */
export function createContributionStorage(database: PlatformDatabase) {
  const work = new PostgresUnitOfWork<ContributionRepositories>(database, {
    submission: tx => new PostgresContributionSubmission(tx),
    skillImpact: tx => new PostgresContributionSkillImpact(tx),
    plugins: tx => new PostgresPluginLibraryStore(tx),
    pluginGrants: tx => new PostgresPluginGrants(tx),
    pluginSelections: tx => new PostgresPluginSelections(tx),
    pluginAccess: tx => new PostgresPluginAccessStore(tx),
    pluginUpstreams: tx => new PostgresPluginUpstreams(tx),
    accounts: tx => new PostgresContributionActors(tx),
    contributions: tx => new PostgresContributionRows(tx),
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
  })
  return { rows: new PostgresContributionRows(database), work, actions: new ContributionTransactions(work, new YamlPluginAccessSyntax()) }
}
