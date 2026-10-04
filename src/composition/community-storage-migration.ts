import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { FileCommunityUserStorageMigration } from '../adapters/community-user-storage-migration.js'
import { CommunityRuntimeDriver } from '../adapters/community-runtime-driver.js'
import { CommunityUserStorageMigration } from '../use-cases/community-user-storage-migration.js'

export function createCommunityStorageMigration(config: CommunityRuntimeConfig): CommunityUserStorageMigration {
  return new CommunityUserStorageMigration(new FileCommunityUserStorageMigration(config, new CommunityRuntimeDriver(config)))
}
