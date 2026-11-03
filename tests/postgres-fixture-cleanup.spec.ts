import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { expect, it, vi } from 'vitest'
import { dropCreatedDatabase, dropCreatedDatabases, postgresConnection } from './support/postgres.js'

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

it('retains owned databases after a partial cleanup failure so cleanup can retry without dropping later databases', async () => {
  const first = postgresConnection(),
    blocked = postgresConnection(),
    last = postgresConnection()
  const connect = (database: string) => new Pool({ host: first.host, port: first.port, database, user: first.username, password: first.password, max: 1 })
  const admin = connect('postgres')
  const databases = [first.database, blocked.database, last.database]
  const present = async () =>
    (await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = ANY($1) ORDER BY datname', [databases])).rows.map(
      row => row.datname,
    )
  try {
    const subscriber = connect(blocked.database)
    try {
      await subscriber.query(
        "CREATE SUBSCRIPTION fixture_cleanup CONNECTION 'host=127.0.0.1 port=1 user=fixture' PUBLICATION fixture WITH (connect=false, create_slot=false, enabled=false, slot_name=NONE)",
      )
    } finally {
      await subscriber.end()
    }
    expect(() => dropCreatedDatabases()).toThrow()
    expect(await present()).toEqual([blocked.database, last.database].sort())
    const repair = connect(blocked.database)
    try {
      await repair.query('DROP SUBSCRIPTION fixture_cleanup')
    } finally {
      await repair.end()
    }
    dropCreatedDatabases()
    expect(await present()).toEqual([])
  } finally {
    if ((await present()).includes(blocked.database)) {
      const repair = connect(blocked.database)
      try {
        await repair.query('DROP SUBSCRIPTION IF EXISTS fixture_cleanup')
      } finally {
        await repair.end()
      }
    }
    for (const database of databases) await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    await admin.end()
  }
})

it('refuses to remove a database the fixture did not create', async () => {
  const own = postgresConnection(),
    foreign = 'outside_' + randomUUID().replaceAll('-', '')
  const admin = new Pool({ host: own.host, port: own.port, database: 'postgres', user: own.username, password: own.password, max: 1 })
  try {
    await admin.query(`CREATE DATABASE "${foreign}"`)
    expect(() => dropCreatedDatabase(foreign)).toThrow()
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [foreign])).rowCount).toBe(1)
    dropCreatedDatabases()
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [foreign])).rowCount).toBe(1)
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${foreign}" WITH (FORCE)`)
    await admin.end()
  }
})

it('uses only the injected fixture connection when PostgreSQL environment defaults point elsewhere', async () => {
  vi.stubEnv('PGHOST', '127.0.0.1')
  vi.stubEnv('PGPORT', '1')
  vi.stubEnv('PGDATABASE', 'outside_fixture')
  vi.stubEnv('PGUSER', 'outside_fixture')
  vi.stubEnv('PGPASSWORD', 'fictional-outside-password')
  vi.stubEnv('PGSSLMODE', 'require')
  let pool: Pool | undefined
  try {
    const connection = postgresConnection()
    pool = new Pool({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.username,
      password: connection.password,
      ssl: false,
    })
    expect((await pool.query('SELECT current_database() AS database')).rows).toEqual([{ database: connection.database }])
    await pool.end()
    pool = undefined
    dropCreatedDatabases()
  } finally {
    await pool?.end()
    vi.unstubAllEnvs()
  }
})
