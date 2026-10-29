import { PostgresUsageRecords } from '../../src/adapters/postgres-usage-records.js'
import { PlatformDatabase } from '../../src/adapters/platform-database.js'
import { FilePlatformSecrets } from '../../src/adapters/platform-secrets.js'
import { postgresConnection } from './postgres.js'
import type { PlatformDatabaseConnection } from '../../src/domain/platform-database.js'
import type { PlatformSecretRegistry } from '../../src/domain/platform-secret.js'
const databases = new Map<
  string,
  {
    connection: PlatformDatabaseConnection
    masterKeyPath: string
    registry: PlatformSecretRegistry
  }
>()
export async function openUsageRecords(path: string) {
  let saved = databases.get(path)
  if (!saved) {
    const masterKeyPath = path + '.master',
      secrets = FilePlatformSecrets.create(masterKeyPath)
    saved = { connection: postgresConnection(), masterKeyPath, registry: secrets.registry() }
    secrets.close()
    databases.set(path, saved)
  }
  const db = new PlatformDatabase(saved.connection, saved)
  try {
    await db.initialize()
    const store = new PostgresUsageRecords(db)
    return Object.assign(store, { close: () => db.close() })
  } catch (error) {
    await db.close()
    throw error
  }
}
