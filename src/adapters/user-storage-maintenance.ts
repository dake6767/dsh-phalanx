import { basename, dirname, join } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import type { UserStorageMaintenance } from '../ports/user-storage-facts.js'
import { FilePlatformDatabaseConfig } from './platform-database-config.js'
import { PlatformDatabase } from './platform-database.js'
import { PostgresUserStorageFacts } from './postgres-user-storage-facts.js'

/** The migration calls open only while holding PlatformLock; construction opens no SQL owner. */
export class PlatformUserStorageMaintenance implements UserStorageMaintenance {
  readonly recordsDirectory: string
  private readonly configFile: string
  private database: PlatformDatabase | undefined
  constructor(
    configFile: string,
    private readonly dataRoot: string,
  ) {
    const directory = realpathSync(dirname(configFile))
    this.configFile = join(directory, basename(configFile))
    this.recordsDirectory = join(directory, 'storage-migrations')
  }
  async open(): Promise<PostgresUserStorageFacts> {
    if (this.database) throw new Error('Storage maintenance database is already open')
    if (statSync(this.configFile).uid !== process.getuid?.()) throw new Error('Run storage migration as the configuration owner')
    const saved = FilePlatformDatabaseConfig.open(this.configFile, this.dataRoot)
    if (!saved.deploymentId) throw new Error('The platform deployment identity is missing')
    this.database = new PlatformDatabase(saved.connection, saved.security)
    await this.database.claimDeployment(saved.deploymentId, () => {})
    await this.database.initialize()
    return new PostgresUserStorageFacts(this.database)
  }
  async close(): Promise<void> {
    try {
      await this.database?.close()
    } finally {
      this.database = undefined
    }
  }
}
