import { postgresConnection } from './support/postgres.js'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { BootstrapDatabase } from '../src/adapters/bootstrap-database.js'
import { CommunityDatabaseOnboarding } from '../src/use-cases/community-database-onboarding.js'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FilePlatformDatabaseConfig } from '../src/adapters/platform-database-config.js'
const connection = {
  host: '127.0.0.1',
  port: 5432,
  database: 'platform',
  username: 'platform',
  password: 'fictional-database-password',
  tls: 'disable' as const,
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'platform-config-')),
    data = join(root, 'data'),
    path = join(root, 'database.json'),
    master = join(root, 'master.key')
  mkdirSync(data)
  return { root, data, path, master }
}
it('stores only an authenticated encrypted password and reopens its protected local configuration', () => {
  const { root, data, path, master } = setup()
  try {
    FilePlatformDatabaseConfig.create(path, master, connection)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(master).mode & 0o777).toBe(0o600)
    expect(readFileSync(master)).toHaveLength(32)
    expect(readFileSync(path, 'utf8')).not.toContain(connection.password)
    expect(FilePlatformDatabaseConfig.open(path, data).connection).toEqual(connection)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('rejects unsafe file permissions and refuses to recreate a missing master key', () => {
  const { root, data, path, master } = setup()
  try {
    FilePlatformDatabaseConfig.create(path, master, connection)
    chmodSync(path, 0o644)
    expect(() => FilePlatformDatabaseConfig.open(path, data)).toThrow('0600')
    chmodSync(path, 0o600)
    rmSync(master)
    expect(() => FilePlatformDatabaseConfig.open(path, data)).toThrow('master-key file is missing')
    expect(existsSync(master)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('rejects database configuration or master-key files inside the mutable data root', () => {
  for (const location of ['configuration', 'key']) {
    const { root, data, path, master } = setup()
    try {
      const target = location === 'configuration' ? join(data, 'database.json') : path
      const key = location === 'key' ? join(data, 'master.key') : master
      FilePlatformDatabaseConfig.create(target, key, connection)
      expect(() => FilePlatformDatabaseConfig.open(target, data)).toThrow('outside the data root')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

it('atomically selects an external connection with the same offline master key and no plaintext password', () => {
  const { root, data, path, master } = setup()
  try {
    FilePlatformDatabaseConfig.create(path, master, connection)
    const before = readFileSync(master),
      registry = FilePlatformDatabaseConfig.open(path, data).security.registry
    const external = { ...connection, host: 'database.example.test', password: 'fictional-external-database-password', tls: 'require' as const }
    FilePlatformDatabaseConfig.select(path, data, external, 'external')
    const selected = FilePlatformDatabaseConfig.open(path, data)
    expect(selected.connection).toEqual(external)
    expect(selected.selection).toBe('external')
    expect(selected.deploymentId).toMatch(/^[a-f0-9-]{36}$/u)
    expect(selected.security.registry).toEqual(registry)
    expect(readFileSync(master)).toEqual(before)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).not.toContain(external.password)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('recognizes a committed target when directory synchronization fails after rename', async () => {
  const { root, data, path, master } = setup()
  const connection = postgresConnection()
  FilePlatformDatabaseConfig.create(path, master, connection)
  const saved = FilePlatformDatabaseConfig.open(path, data),
    database = new PlatformDatabase(saved.connection, saved.security)
  const storage = new BootstrapDatabase(path, data, database)
  let failed = false,
    activated = false
  const service = new CommunityDatabaseOnboarding(
    { verify: () => true, consume() {} },
    storage,
    async () => {
      activated = true
    },
    () => {
      failed = true
    },
  )
  try {
    // Search/write permit the atomic rename; opening this directory for fsync requires read permission.
    chmodSync(root, 0o300)
    await expect(service.select('fixture-invitation', connection)).rejects.toMatchObject({ code: 'EACCES' })
    expect(service.pending()).toBe(false)
    expect(FilePlatformDatabaseConfig.open(path, data).selection).toBe('external')
    expect(failed).toBe(true)
    expect(activated).toBe(false)
  } finally {
    chmodSync(root, 0o700)
    await service.close()
    await database.close()
    rmSync(root, { recursive: true, force: true })
  }
})
