import type { RuntimeDependency } from '../domain/runtime-dependency.js'
import type { RuntimeDependencyView } from '../ports/runtime-dependencies.js'
import type { PlatformDatabase } from './platform-database.js'
import { PostgresCommittedView } from './postgres-committed-view.js'
import { PostgresRuntimeDependencyStore } from './postgres-runtime-dependencies.js'

export const runtimeFactTables = ['dsh_phalanx.runtime_dependencies']

/** The sole published dependency view for synchronous readiness, frozen plans and source leases. */
export class PostgresRuntimeFacts implements RuntimeDependencyView {
  private readonly committed: PostgresCommittedView<readonly RuntimeDependency[]>
  constructor(private readonly database: PlatformDatabase) {
    this.committed = new PostgresCommittedView(database, runtimeFactTables, () => new PostgresRuntimeDependencyStore(database).list())
  }
  initialize(): Promise<void> {
    return this.committed.initialize()
  }
  close(): Promise<void> {
    return this.committed.close()
  }
  list(): readonly RuntimeDependency[] {
    return this.committed.read(rows => rows)
  }
  version(): string {
    this.committed.read(() => undefined)
    return this.database.writeRevision(runtimeFactTables)
  }
}
