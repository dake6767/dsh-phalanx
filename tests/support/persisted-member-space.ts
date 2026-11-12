import { isAbsolute, relative, resolve, sep } from 'node:path'
import { FilePlatformDatabaseConfig } from '../../src/adapters/platform-database-config.js'
import { platformDatabasePool } from '../../src/adapters/platform-database-inspection.js'
import { effectiveUserDataRoot } from '../../src/domain/storage-layout.js'

/** Read an existing deployment's mapping without creating a fixture database or migrating it. */
export async function persistedMemberSpacePath(dataRoot: string, databaseConfigFile: string, username: string): Promise<string> {
  const config = FilePlatformDatabaseConfig.open(databaseConfigFile, dataRoot)
  const pool = platformDatabasePool(config.connection)
  try {
    const result = await pool.query<{ storage_key: string }>('SELECT storage_key FROM dsh_phalanx.accounts WHERE username=$1', [username])
    const key = result.rows[0]?.storage_key
    if (!key) throw Error('Account has no persisted space mapping')
    const base = effectiveUserDataRoot({ dataRoot }),
      path = resolve(base, key),
      inside = relative(base, path)
    if (isAbsolute(key) || !inside || inside === '..' || inside.startsWith('..' + sep)) throw Error('Invalid persisted space mapping')
    return path
  } finally {
    await pool.end()
  }
}
