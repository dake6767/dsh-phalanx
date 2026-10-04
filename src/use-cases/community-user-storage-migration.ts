import type { CommunityUserStorageMigrationPort, CommunityUserStorageMigrationResult } from '../ports/community-user-storage-migration.js'

/** Publish a storage switch only after stopped-carrier copying and verification. */
export class CommunityUserStorageMigration {
  constructor(private readonly storage: CommunityUserStorageMigrationPort) {}
  async migrate(targetRoot: string, targetMount: string): Promise<CommunityUserStorageMigrationResult> {
    try {
      const prepared = await this.storage.prepare(targetRoot, targetMount)
      if (prepared.state === 'complete') return prepared.result
      await this.storage.stopCarriers()
      await this.storage.copy()
      await this.storage.verify()
      return await this.storage.publish()
    } finally { await this.storage.close() }
  }
}
