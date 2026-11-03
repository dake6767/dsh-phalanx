import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { inject } from 'vitest'
import type { PlatformDatabaseConnection } from '../../src/domain/platform-database.js'
import type { PostgresFixtureInfo } from './postgres-runtime.js'

declare module 'vitest' {
  export interface ProvidedContext {
    postgres: PostgresFixtureInfo
  }
}

const created: string[] = []
const controlProgram = `
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
const { connection, statements } = JSON.parse(readFileSync(0, 'utf8'));
const client = new Client({ ...connection, ssl: false, connectionTimeoutMillis: 10000, query_timeout: 30000 });
let failure;
try {
  await client.connect();
  for (const statement of statements) await client.query(statement);
} catch (error) {
  failure = error;
}
try { await client.end(); } catch (error) { failure ??= error; }
if (failure !== undefined) {
  const code = typeof failure?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(failure.code) ? failure.code : 'unknown';
  process.stderr.write('PostgreSQL fixture control failed: ' + code + '\\n');
  process.exitCode = 1;
}
`

function executePostgresStatements(fixture: PostgresFixtureInfo, statements: readonly string[]) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', controlProgram], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, ...fixture.environment },
    input: JSON.stringify({
      connection: { host: fixture.host, port: fixture.port, database: 'postgres', user: 'postgres', password: fixture.password },
      statements,
    }),
    stdio: 'pipe',
    timeout: 60_000,
  })
}

export function postgresConnection(): PlatformDatabaseConnection {
  const fixture = inject('postgres'),
    database = 'phalanx_' + randomUUID().replaceAll('-', '')
  executePostgresStatements(fixture, [`CREATE DATABASE "${database}"`])
  created.push(database)
  return { host: fixture.host, port: fixture.port, database, username: 'postgres', password: fixture.password, tls: 'disable' }
}

/** A closed per-case owner can release its database before the rest of a large file runs. */
export function dropCreatedDatabase(database: string): void {
  const index = created.indexOf(database)
  if (index < 0) throw Error('Refusing to drop a database this file did not create')
  executePostgresStatements(inject('postgres'), [`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`])
  created.splice(index, 1)
}

/** Drop this file's databases so one container does not accumulate every suite's data and WAL. */
export function dropCreatedDatabases(): void {
  if (!created.length) return
  // Each statement commits separately; retain ownership after partial failure so IF EXISTS can retry.
  executePostgresStatements(
    inject('postgres'),
    created.map(database => `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`),
  )
  created.splice(0)
}
