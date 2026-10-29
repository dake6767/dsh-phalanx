import { join } from 'node:path'
import { FileSkillArtifacts } from '../adapters/skill-artifacts.js'
import { GitSkillRepository } from '../adapters/skill-git.js'
import type { PlatformDatabase } from '../adapters/platform-database.js'
import { PostgresUnitOfWork, type PlatformTransaction } from '../adapters/postgres-unit-of-work.js'
import { PostgresSkillFacts } from '../adapters/postgres-skill-facts.js'
import { PostgresSkillLibraryStore } from '../adapters/postgres-skill-library.js'
import { PostgresSkillPackStore } from '../adapters/postgres-skill-packs.js'
import { PostgresSkillAssignments } from '../adapters/postgres-skill-assignments.js'
import type { SkillRepositories } from '../ports/skill-unit-of-work.js'
import { PostgresExpertReferences } from '../adapters/postgres-expert-references.js'

/** Ordinary repositories read PostgreSQL on demand; synchronous consumers share one committed publication. */
export function createSkillStorage(database: PlatformDatabase) {
  const facts = new PostgresSkillFacts(database)
  const assignments = (connection: PlatformDatabase | PlatformTransaction, kind: 'skills' | 'packs', scope: 'grants' | 'selections') =>
    new PostgresSkillAssignments(connection, kind, scope)
  const packRepositories = (connection: PlatformDatabase | PlatformTransaction) => ({
    store: new PostgresSkillPackStore(connection),
    grants: assignments(connection, 'packs', 'grants'),
    selections: assignments(connection, 'packs', 'selections'),
  })
  const packs = packRepositories(database)
  const work = new PostgresUnitOfWork<SkillRepositories>(database, {
    library: connection => new PostgresSkillLibraryStore(connection),
    packs: packRepositories,
    grants: connection => assignments(connection, 'skills', 'grants'),
    selections: connection => assignments(connection, 'skills', 'selections'),
    expertReferences: connection => new PostgresExpertReferences(connection),
  })
  return {
    library: Object.assign(new PostgresSkillLibraryStore(database), { view: facts.library, initialize: () => facts.initialize() }),
    grants: Object.assign(assignments(database, 'skills', 'grants'), { view: facts.grants }),
    selections: Object.assign(assignments(database, 'skills', 'selections'), { view: facts.selections }),
    packs: {
      store: Object.assign(packs.store, { view: facts.packs.store }),
      grants: Object.assign(packs.grants, { view: facts.packs.grants }),
      selections: Object.assign(packs.selections, { view: facts.packs.selections }),
    },
    work,
    initialize: () => facts.initialize(),
    close: () => facts.close(),
  }
}

/** Artifact preparation stays outside fact transactions. */
export function createSkillArtifacts(root: string, bundled: readonly string[]) {
  return new FileSkillArtifacts(join(root, 'artifacts'), bundled, new GitSkillRepository(join(root, 'git-intake'), { caFile: process.env.GIT_SSL_CAINFO }))
}
