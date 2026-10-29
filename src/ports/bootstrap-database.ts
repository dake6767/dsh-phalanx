import type { DatabaseInspection, PlatformDatabaseConnection } from '../domain/platform-database.js'

/** First-install selection; no administrator database-switch capability is exposed. */
export interface BootstrapDatabasePort {
  pending(): boolean
  inspect(connection?: PlatformDatabaseConnection): Promise<DatabaseInspection>
  select(connection?: PlatformDatabaseConnection): Promise<void>
}
