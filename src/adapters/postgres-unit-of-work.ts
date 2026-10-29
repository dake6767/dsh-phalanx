import type { PlatformUnitOfWorkPort } from '../ports/platform-unit-of-work.js'
import type { PlatformDatabase, PlatformSql } from './platform-database.js'
import type { PlatformSecretCipher } from './platform-secret-codec.js'

/** What a repository receives: this transaction's statements and the platform key owner. */
export interface PlatformTransaction {
  readonly sql: PlatformSql
  readonly cipher: PlatformSecretCipher
}

/** Builds each domain repository bound to one transaction. Composition supplies one per domain. */
export type RepositoryFactories<Repositories> = { readonly [Name in keyof Repositories]: (transaction: PlatformTransaction) => Repositories[Name] }

/** Runs each unit in one PostgreSQL transaction; any thrown error rolls every repository's writes back. */
export class PostgresUnitOfWork<Repositories> implements PlatformUnitOfWorkPort<Repositories> {
  constructor(
    private readonly database: PlatformDatabase,
    private readonly factories: RepositoryFactories<Repositories>,
  ) {}
  run<T>(operation: (repositories: Repositories) => Promise<T>, committed?: (value: T) => void): Promise<T> {
    return this.database.transaction(async sql => {
      const transaction = { sql, cipher: this.database.cipher() }
      const repositories = Object.fromEntries(
        Object.entries(this.factories).map(([name, factory]) => [name, (factory as (value: PlatformTransaction) => unknown)(transaction)]),
      ) as Repositories
      return await operation(repositories)
    }, committed)
  }
}
