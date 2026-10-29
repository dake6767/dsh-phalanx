import type { PluginInstallation, PluginInstallationsPort } from '../ports/plugin-installations.js'
import { pluginSql, type PluginRepositoryConnection } from './postgres-plugin-repository.js'

/** Latest successful native delivery per package survives plugin retirement. */
export class PostgresPluginInstallations implements PluginInstallationsPort {
  constructor(private readonly connection: PluginRepositoryConnection) {}
  async get(spaceId: string): Promise<readonly PluginInstallation[]> {
    return (
      await pluginSql(this.connection).query<{ package_name: string; version: string; source: PluginInstallation['source'] }>(
        'SELECT package_name,version,source FROM dsh_phalanx.plugin_deliveries WHERE space_id=$1 ORDER BY package_name',
        [spaceId],
      )
    ).map(({ package_name, ...row }) => ({ packageName: package_name, ...row }))
  }
  async save(spaceId: string, record: PluginInstallation): Promise<void> {
    await pluginSql(this.connection).query(
      `INSERT INTO dsh_phalanx.plugin_deliveries(space_id,package_name,version,source) VALUES($1,$2,$3,$4) ON CONFLICT(space_id,package_name) DO UPDATE SET version=EXCLUDED.version,source=EXCLUDED.source`,
      [spaceId, record.packageName, record.version, record.source],
    )
  }
  async clearPreinstalls(spaceId: string): Promise<void> {
    await pluginSql(this.connection).query("DELETE FROM dsh_phalanx.plugin_deliveries WHERE space_id=$1 AND source='preinstall'", [spaceId])
  }
}
