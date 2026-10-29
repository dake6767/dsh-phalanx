import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { inject } from 'vitest'
import type { PlatformDatabaseConnection } from '../../src/domain/platform-database.js'
import type { PostgresFixtureInfo } from './postgres-runtime.js'

declare module 'vitest' {
  export interface ProvidedContext {
    postgres: PostgresFixtureInfo
  }
}

const created: string[] = []
function psql(fixture: PostgresFixtureInfo, statements: readonly string[]) {
  return execFileSync(
    fixture.command[0]!,
    [
      ...fixture.command.slice(1),
      'exec',
      fixture.container,
      'psql',
      '-X',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      ...statements.flatMap(statement => ['-c', statement]),
    ],
    { env: { ...process.env, ...fixture.environment }, stdio: 'pipe' },
  )
}

export function postgresConnection(): PlatformDatabaseConnection {
  const fixture = inject('postgres'),
    database = 'phalanx_' + randomUUID().replaceAll('-', '')
  psql(fixture, [`CREATE DATABASE "${database}"`])
  created.push(database)
  return { host: fixture.host, port: fixture.port, database, username: 'postgres', password: fixture.password, tls: 'disable' }
}

/** A closed per-case owner can release its database before the rest of a large file runs. */
export function dropCreatedDatabase(database: string): void {
  const index = created.indexOf(database)
  if (index < 0) throw Error('Refusing to drop a database this file did not create')
  psql(inject('postgres'), [`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`])
  created.splice(index, 1)
}

/** Drop this file's databases so one container does not accumulate every suite's data and WAL. */
export function dropCreatedDatabases(): void {
  if (!created.length) return
  // Runs after every case in the file; FORCE ends connections the file's own tests left open.
  psql(
    inject('postgres'),
    created.splice(0).map(database => `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`),
  )
}
