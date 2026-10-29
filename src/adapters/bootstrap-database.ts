import { isDeepStrictEqual } from 'node:util'
import { BusinessRuleError } from '../domain/business-error.js'
import type { PlatformDatabaseConnection } from '../domain/platform-database.js'
import type { BootstrapDatabasePort } from '../ports/bootstrap-database.js'
import { FilePlatformDatabaseConfig } from './platform-database-config.js'
import { PlatformDatabase } from './platform-database.js'
import { inspectPlatformDatabase, readPlatformDatabaseState } from './platform-database-inspection.js'

/** Owns the local selection commit and binds the shared database before its owners initialize. */
export class BootstrapDatabase implements BootstrapDatabasePort {
  private uncertain = false
  private saved: ReturnType<typeof FilePlatformDatabaseConfig.open>
  constructor(
    private readonly path: string,
    private readonly dataRoot: string,
    private readonly database: PlatformDatabase,
  ) {
    this.saved = FilePlatformDatabaseConfig.open(path, dataRoot)
  }
  selection(): 'builtin' | 'external' {
    if (!this.saved.selection || this.uncertain) throw Error('Platform database selection is unavailable')
    return this.saved.selection
  }
  pending(): boolean {
    return this.saved.selection === undefined && !this.uncertain
  }
  async complete(): Promise<boolean> {
    return (await readPlatformDatabaseState(this.saved.connection)).complete
  }
  async prepare(): Promise<boolean> {
    if (!this.pending()) return true
    if (!(await this.complete())) return false
    await this.select()
    return true
  }
  inspect(connection = this.saved.connection) {
    return inspectPlatformDatabase(connection, this.saved.security.registry.masterFingerprint, this.saved.deploymentId)
  }
  async select(connection?: PlatformDatabaseConnection): Promise<void> {
    const target = connection ?? this.saved.connection,
      kind = connection === undefined ? 'builtin' : 'external'
    if (!this.pending()) {
      if (this.saved.selection !== kind || !isDeepStrictEqual(target, this.saved.connection))
        throw new BusinessRuleError('conflict', 'Platform database selection is already committed', 'database-selection-committed')
      return
    }
    const result = await this.inspect(target)
    if (!result.ok)
      throw new BusinessRuleError('invalid', 'Platform database connection checks failed', 'database-connection-check-failed', {
        stage: result.checks.at(-1)?.stage ?? 'connection',
      })
    try {
      FilePlatformDatabaseConfig.select(this.path, this.dataRoot, target, kind)
      this.saved = FilePlatformDatabaseConfig.open(this.path, this.dataRoot)
      await this.database.bindBeforeInitialization(this.saved.connection)
    } catch (error) {
      // Rename may already have committed the target even when directory fsync fails.
      try {
        this.saved = FilePlatformDatabaseConfig.open(this.path, this.dataRoot)
      } catch {
        this.uncertain = true
      }
      throw error
    }
  }
  async claim(onLost: () => void): Promise<void> {
    if (!this.saved.deploymentId) throw Error('Platform deployment identity is missing from its local connection configuration')
    await this.database.claimDeployment(this.saved.deploymentId, onLost)
  }
}
