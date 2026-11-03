import type { NativePluginHistoryRows } from '../ports/native-plugin-history.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'

/** Eligibility only grows. The separate header distinguishes an empty baseline from an uninitialized member. */
export class PostgresNativePluginHistory implements NativePluginHistoryRows {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async read(spaceId: string): Promise<readonly string[] | undefined> {
    const rows = await repositorySql(this.connection).query<{ name: string | null }>(
      `SELECT n.bundle_name AS name FROM dsh_phalanx.native_plugin_baselines b
       LEFT JOIN dsh_phalanx.native_plugin_history n ON n.space_id=b.space_id WHERE b.space_id=$1 ORDER BY n.bundle_name`,
      [spaceId],
    )
    return rows.length ? rows.flatMap(row => (row.name === null ? [] : [row.name])) : undefined
  }
  remember(spaceId: string, names: readonly string[]): Promise<readonly string[]> {
    return repositoryTransaction(this.connection, async sql => {
      await sql.query('INSERT INTO dsh_phalanx.native_plugin_baselines(space_id) VALUES($1) ON CONFLICT DO NOTHING', [spaceId])
      if (names.length)
        await sql.query(
          `INSERT INTO dsh_phalanx.native_plugin_history(space_id,bundle_name)
        SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING`,
          [spaceId, [...new Set(names)]],
        )
      return (
        await sql.query<{ bundle_name: string }>('SELECT bundle_name FROM dsh_phalanx.native_plugin_history WHERE space_id=$1 ORDER BY bundle_name', [spaceId])
      ).map(row => row.bundle_name)
    })
  }
}
