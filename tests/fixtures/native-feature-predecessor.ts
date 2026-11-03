import { PlatformDatabase } from '../../src/adapters/platform-database.js'
import { FilePlatformDatabaseConfig } from '../../src/adapters/platform-database-config.js'
import { PostgresCommunityAccountStore } from '../../src/adapters/postgres-community-accounts.js'
import { PLATFORM_MIGRATIONS } from '../../src/adapters/platform-schema.js'
import { testDatabaseConfigFile } from '../support/community-application.js'

/** A real schema-15 installation, before native-feature settings existed. */
export async function nativeFeaturePredecessor(dataRoot: string) {
  const path = testDatabaseConfigFile(dataRoot)
  let saved = FilePlatformDatabaseConfig.open(path, dataRoot)
  if (saved.selection === undefined) {
    FilePlatformDatabaseConfig.select(path, dataRoot, saved.connection, 'builtin')
    saved = FilePlatformDatabaseConfig.open(path, dataRoot)
  }
  const database = new PlatformDatabase(saved.connection, saved.security, [
    { name: 'dsh_phalanx', migrations: PLATFORM_MIGRATIONS.filter(migration => migration.version <= 15) },
  ])
  try {
    await database.initialize()
    return { database, accounts: new PostgresCommunityAccountStore(database) }
  } catch (error) {
    await database.close()
    throw error
  }
}
