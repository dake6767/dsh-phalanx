import type { PlatformDatabase, PlatformSql } from './platform-database.js'
import type { PlatformTransaction } from './postgres-unit-of-work.js'

/** A row repository joins its use-case transaction or creates one for an ordinary write. */
export type RowRepositoryConnection = PlatformDatabase | PlatformTransaction
export function repositorySql(connection: RowRepositoryConnection): PlatformSql {
  return 'sql' in connection ? connection.sql : connection
}
export function repositoryTransaction<T>(connection: RowRepositoryConnection, run: (sql: PlatformSql) => Promise<T>): Promise<T> {
  return 'sql' in connection ? run(connection.sql) : connection.transaction(run)
}
