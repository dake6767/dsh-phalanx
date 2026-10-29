import type { CommunityConfig } from '../domain/community-config.js'
import { PlatformUserStorageMaintenance } from '../adapters/user-storage-maintenance.js'
import { FileCommunityUserStorageMigration } from '../adapters/community-user-storage-migration.js'
import { CommunityRuntimeDriver } from '../adapters/community-runtime-driver.js'
import { CommunityUserStorageMigration } from '../use-cases/community-user-storage-migration.js'

/** The adapter acquires PlatformLock before this lazy owner opens protected database configuration. */
export function createCommunityStorageMigration(config: Pick<CommunityConfig, 'runtime' | 'platformDatabaseConfigFile'>): CommunityUserStorageMigration {
  const maintenance = new PlatformUserStorageMaintenance(config.platformDatabaseConfigFile ?? '/etc/dsh-phalanx/database.json', config.runtime.dataRoot)
  return new CommunityUserStorageMigration(
    new FileCommunityUserStorageMigration(config.runtime, new CommunityRuntimeDriver(config.runtime), maintenance, maintenance.recordsDirectory),
  )
}
