import { Pool } from 'pg'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { initializeBuiltinDatabase, writeBuiltinDatabasePassword, waitForPlatformDatabase } from '../src/adapters/builtin-database-setup.js'
import { FilePlatformDatabaseConfig } from '../src/adapters/platform-database-config.js'
import { postgresConnection } from './support/postgres.js'
it('initializes once without exposing a master or database password and prepares only a private transient password file', () => {
  const root = mkdtempSync(join(tmpdir(), 'builtin-database-')),
    data = join(root, 'data'),
    path = join(root, 'database.json'),
    master = join(root, 'master.key'),
    output = join(root, 'password')
  mkdirSync(data)
  try {
    const result = initializeBuiltinDatabase(path, master, data, 25432)
    const saved = FilePlatformDatabaseConfig.open(path, data)
    expect(result).toEqual({ masterKeyPath: master, fingerprint: saved.security.registry.masterFingerprint, port: 25432 })
    expect(saved.connection.password.length).toBeGreaterThanOrEqual(32)
    expect(JSON.stringify(result)).not.toContain(saved.connection.password)
    expect(initializeBuiltinDatabase(path, master, data, 25432)).toEqual(result)
    expect(readFileSync(master)).toHaveLength(32)
    writeBuiltinDatabasePassword(path, data, output)
    expect(statSync(output).mode & 0o777).toBe(0o600)
    expect(readFileSync(output, 'utf8')).toBe(saved.connection.password)
    rmSync(master)
    expect(() => initializeBuiltinDatabase(path, master, data, 25432)).toThrow('master-key file is missing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('checks actual PostgreSQL readiness without writing schema or business records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'builtin-readiness-')),
    data = join(root, 'data'),
    path = join(root, 'database.json')
  mkdirSync(data)
  try {
    const connection = postgresConnection()
    FilePlatformDatabaseConfig.create(path, join(root, 'master.key'), connection)
    expect(await waitForPlatformDatabase(path, data)).toMatchObject({ state: 'connected', schemaVersion: 0 })
    const observer = new Pool({ ...connection, user: connection.username })
    try {
      expect((await observer.query("SELECT to_regnamespace('dsh_phalanx') AS schema")).rows).toEqual([{ schema: null }])
    } finally {
      await observer.end()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps built-in PostgreSQL credentials independent after the platform selects an external database', () => {
  const root = mkdtempSync(join(tmpdir(), 'builtin-independent-')),
    data = join(root, 'data'),
    path = join(root, 'database.json'),
    master = join(root, 'master.key'),
    output = join(root, 'password')
  mkdirSync(data)
  try {
    const initial = initializeBuiltinDatabase(path, master, data, 25432),
      original = FilePlatformDatabaseConfig.open(path, data)
    const builtin = join(root, 'builtin-database.json')
    expect(statSync(builtin).mode & 0o777).toBe(0o600)
    FilePlatformDatabaseConfig.select(
      path,
      data,
      { ...original.connection, host: 'database.example.test', port: 5432, password: 'fictional-external-database-value', tls: 'require' },
      'external',
    )
    writeBuiltinDatabasePassword(builtin, data, output)
    expect(readFileSync(output, 'utf8')).toBe(original.connection.password)
    expect(initializeBuiltinDatabase(path, master, data, 25432)).toEqual(initial)
    expect(FilePlatformDatabaseConfig.open(path, data).selection).toBe('external')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
