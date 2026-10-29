import { existsSync } from 'node:fs'
import { downloadSourceSelection, type DownloadSourceSelection } from '../domain/download-source.js'
import { PlatformDatabaseError } from '../domain/platform-database.js'
import { FilePlatformDatabaseConfig } from './platform-database-config.js'
import { platformDatabasePool } from './platform-database-inspection.js'

/**
 * Read-only facts the installer and upgrader need, served by the installed platform
 * so they never open PostgreSQL or parse platform files themselves. Nothing here
 * migrates, locks or writes; a missing schema reads as "nothing saved yet".
 */

/** The download choice an administrator saved, or undefined when none is saved. */
export async function savedDownloadSources(configFile: string, dataRoot: string): Promise<DownloadSourceSelection | undefined> {
  // A deployment that has not selected its database yet has nothing saved; its local choice applies.
  if (!existsSync(configFile)) return undefined
  const pool = platformDatabasePool(FilePlatformDatabaseConfig.open(configFile, dataRoot).connection)
  let row: { selection: unknown } | undefined
  try {
    const [present] = (await pool.query<{ table: string | null }>("SELECT to_regclass('dsh_phalanx.download_sources')::text AS table")).rows
    if (!present?.table) return undefined
    row = (await pool.query<{ selection: unknown }>('SELECT selection FROM dsh_phalanx.download_sources WHERE id=1')).rows[0]
  } catch {
    // Only failing to reach or query the database is "unavailable"; a malformed saved row is reported below.
    throw new PlatformDatabaseError('unavailable', 'Platform database is unavailable; check the database service and connection settings')
  } finally {
    await pool.end()
  }
  if (!row) return undefined
  try {
    return downloadSourceSelection(row.selection)
  } catch {
    throw Error('The saved download sources in the platform database are invalid; save them again in Administration')
  }
}

/** Library rows the startup budget counts: whether removal is pending, the target last checked, and a pending replacement. */
export interface PluginBudgetRow {
  readonly removing: boolean
  readonly checkedFor: string | null
  readonly replacement: boolean
}

/** Read-only PostgreSQL library projection; missing pre-initialization schema is empty. */
export async function pluginBudgetRows(configFile: string, dataRoot: string): Promise<readonly PluginBudgetRow[]> {
  if (!existsSync(configFile)) return []
  const pool = platformDatabasePool(FilePlatformDatabaseConfig.open(configFile, dataRoot).connection)
  try {
    const [present] = (await pool.query<{ table: string | null }>("SELECT to_regclass('dsh_phalanx.plugin_library')::text AS table")).rows
    if (!present?.table) return []
    return (
      await pool.query<{ configuration: { checkedFor?: string }; replacement: unknown }>(
        'SELECT configuration,replacement FROM dsh_phalanx.plugin_library ORDER BY package_name',
      )
    ).rows.map(({ configuration, replacement }) => ({ removing: false, checkedFor: configuration.checkedFor ?? null, replacement: Boolean(replacement) }))
  } catch {
    throw new PlatformDatabaseError('unavailable', 'Platform database is unavailable; check the database service and connection settings')
  } finally {
    await pool.end()
  }
}
