import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { dropCreatedDatabases, postgresConnection } from './support/postgres.js'

it('drops the databases a test file created, including ones a test left connected', async () => {
  const kept = postgresConnection(),
    leaked = postgresConnection()
  const admin = new Pool({ host: kept.host, port: kept.port, database: 'postgres', user: kept.username, password: kept.password, max: 1 })
  const open = new Pool({ host: leaked.host, port: leaked.port, database: leaked.database, user: leaked.username, password: leaked.password, max: 1 })
  open.on('error', () => {})
  try {
    await open.query('SELECT 1')
    const present = async () =>
      (await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = ANY($1)', [[kept.database, leaked.database]])).rows.length
    expect(await present()).toBe(2)
    dropCreatedDatabases()
    expect(await present()).toBe(0)
  } finally {
    await Promise.allSettled([open.end(), admin.end()])
  }
})
