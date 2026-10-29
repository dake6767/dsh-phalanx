import type { PlatformDatabase } from '../adapters/platform-database.js'
import { PostgresRuntimeDependencyStore } from '../adapters/postgres-runtime-dependencies.js'
import { PostgresExecutionConfigurations } from '../adapters/postgres-execution-configurations.js'
import { PostgresRuntimeFacts } from '../adapters/postgres-runtime-facts.js'
import { PostgresRuntimeReferences } from '../adapters/postgres-runtime-references.js'
import { PostgresUnitOfWork } from '../adapters/postgres-unit-of-work.js'
import type { RuntimeDependencyStoragePort } from '../ports/runtime-dependencies.js'

export function createRuntimeStorage(database: PlatformDatabase) {
  const rows = new PostgresRuntimeDependencyStore(database)
  const view = new PostgresRuntimeFacts(database)
  const execution = new PostgresExecutionConfigurations(database)
  const store: RuntimeDependencyStoragePort = {
    view,
    list: () => rows.list(),
    save: row => rows.save(row),
    remove: name => rows.remove(name),
  }
  return {
    store,
    execution,
    references: new PostgresRuntimeReferences(database),
    initialize: async () => {
      await view.initialize()
      await execution.initialize()
    },
    close: async () => {
      await Promise.all([view.close(), execution.close()])
    },
    work: new PostgresUnitOfWork(database, {
      runtime: tx => new PostgresRuntimeDependencyStore(tx),
      execution: tx => new PostgresExecutionConfigurations(tx),
      references: tx => new PostgresRuntimeReferences(tx),
    }),
  }
}
