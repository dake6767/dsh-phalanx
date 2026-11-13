import type {
  NativeServiceSettingsHistory,
  PluginInstallation,
  PluginInstallationsPort,
  PluginServiceSettingsHistoryPort,
} from '../ports/plugin-installations.js'
import { pluginSql, pluginTransaction, type PluginRepositoryConnection } from './postgres-plugin-repository.js'

/** Latest successful native delivery per package survives plugin retirement. */
export class PostgresPluginInstallations implements PluginInstallationsPort, PluginServiceSettingsHistoryPort {
  constructor(private readonly connection: PluginRepositoryConnection) {}
  async get(spaceId: string): Promise<readonly PluginInstallation[]> {
    return (
      await pluginSql(this.connection).query<{
        package_name: string
        version: string
        source: PluginInstallation['source']
        integrity: string | null
        service_origin: string | null
        resource_origin: string | null
        service_settings: NativeServiceSettingsHistory | null
      }>(
        'SELECT package_name,version,source,integrity,service_origin,resource_origin,service_settings FROM dsh_phalanx.plugin_deliveries WHERE space_id=$1 ORDER BY package_name',
        [spaceId],
      )
    ).map(({ package_name, integrity, service_origin, resource_origin, service_settings, ...row }) => ({
      packageName: package_name,
      ...row,
      ...(integrity === null ? {} : { integrity }),
      ...(service_origin === null ? {} : { serviceOrigin: service_origin }),
      ...(resource_origin === null ? {} : { resourceOrigin: resource_origin }),
      ...(service_settings === null ? {} : { serviceSettings: service_settings }),
    }))
  }
  async save(spaceId: string, record: PluginInstallation): Promise<void> {
    await pluginSql(this.connection).query(
      `INSERT INTO dsh_phalanx.plugin_deliveries(space_id,package_name,version,source,integrity,service_origin,resource_origin) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(space_id,package_name) DO UPDATE SET version=EXCLUDED.version,source=EXCLUDED.source,integrity=EXCLUDED.integrity,service_origin=EXCLUDED.service_origin,resource_origin=EXCLUDED.resource_origin,service_settings=CASE
        WHEN EXCLUDED.service_origin IS NOT NULL AND plugin_deliveries.service_origin=EXCLUDED.service_origin
        THEN plugin_deliveries.service_settings ELSE NULL END`,
      [spaceId, record.packageName, record.version, record.source, record.integrity ?? null, record.serviceOrigin ?? null, record.resourceOrigin ?? null],
    )
  }
  async replaceServiceSettings(spaceId: string, expected: PluginInstallation, next: NativeServiceSettingsHistory): Promise<boolean> {
    if (!expected.serviceOrigin || !expected.integrity) return false
    const rows = await pluginSql(this.connection).query<{ package_name: string }>(
      `UPDATE dsh_phalanx.plugin_deliveries SET service_settings=$6::jsonb
       WHERE space_id=$1 AND package_name=$2 AND service_origin=$3 AND integrity=$4
       AND service_settings IS NOT DISTINCT FROM $5::jsonb RETURNING package_name`,
      [
        spaceId,
        expected.packageName,
        expected.serviceOrigin,
        expected.integrity,
        expected.serviceSettings ? JSON.stringify(expected.serviceSettings) : null,
        JSON.stringify(next),
      ],
    )
    return rows.length === 1
  }
  async resetForSpace(spaceId: string): Promise<void> {
    await pluginTransaction(this.connection, async sql => {
      await sql.query("DELETE FROM dsh_phalanx.plugin_deliveries WHERE space_id=$1 AND source='preinstall'", [spaceId])
      await sql.query(
        'UPDATE dsh_phalanx.plugin_deliveries SET service_origin=NULL,resource_origin=NULL,service_settings=NULL WHERE space_id=$1 AND (service_origin IS NOT NULL OR resource_origin IS NOT NULL)',
        [spaceId],
      )
    })
  }
}
