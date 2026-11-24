import { randomUUID } from 'node:crypto'
import { nativeJsonSettingsHistoryKey } from '../ports/plugin-installations.js'
import type {
  NativeServiceSettingsHistory,
  PluginInstallation,
  PluginJsonSettingsSummaryPort,
  PluginInstallationsPort,
  PluginServiceSettingsHistoryPort,
  MemberBrowserDeliveryPort,
  MemberBrowserInventoryPort,
  MemberNativeResourcesPort,
  MemberNativeResourceSnapshot,
} from '../ports/plugin-installations.js'
import { pluginServiceGeneration, pluginSql, pluginTransaction, type PluginRepositoryConnection } from './postgres-plugin-repository.js'
import { insertMemberBrowserDependencies, reserveMemberBrowserResources } from './platform-browser-schema.js'
import type { InstalledNativeResourceBinding } from '../domain/plugin-preinstall.js'

const browserReservationOwner = randomUUID()

/** Latest successful native delivery per package survives plugin retirement. */
export class PostgresPluginInstallations
  implements
    PluginInstallationsPort,
    PluginServiceSettingsHistoryPort,
    PluginJsonSettingsSummaryPort,
    MemberBrowserDeliveryPort,
    MemberBrowserInventoryPort,
    MemberNativeResourcesPort
{
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
        browser_bindings: InstalledNativeResourceBinding[] | null
      }>(
        `SELECT d.package_name,d.version,d.source,d.integrity,d.service_origin,d.resource_origin,d.service_settings,
          (SELECT jsonb_agg(b.value ORDER BY m.dependency,b.position)
           FROM dsh_phalanx.member_browser_dependencies m
           CROSS JOIN LATERAL jsonb_array_elements(m.bindings) WITH ORDINALITY AS b(value,position)
           WHERE m.space_id=d.space_id AND m.package_name=d.package_name) AS browser_bindings
         FROM dsh_phalanx.plugin_deliveries d WHERE d.space_id=$1 ORDER BY d.package_name`,
        [spaceId],
      )
    ).map(({ package_name, integrity, service_origin, resource_origin, service_settings, browser_bindings, ...row }) => ({
      packageName: package_name,
      ...row,
      ...(integrity === null ? {} : { integrity }),
      ...(service_origin === null ? {} : { serviceOrigin: service_origin }),
      ...(resource_origin === null ? {} : { resourceOrigin: resource_origin }),
      ...(service_settings === null ? {} : { serviceSettings: service_settings }),
      ...(browser_bindings === null ? {} : { browserBindings: browser_bindings }),
    }))
  }
  async reserveBrowserDelivery(
    spaceId: string,
    packageName: string,
    binding: { version: string; integrity: string; resourceOrigin: string },
    generation?: string,
  ) {
    const reservation = randomUUID()
    const held = await pluginSql(this.connection).query(reserveMemberBrowserResources, [
      reservation,
      spaceId,
      packageName,
      binding.version,
      binding.integrity,
      binding.resourceOrigin,
      browserReservationOwner,
      generation ?? null,
    ])
    return held.length ? reservation : undefined
  }
  async releaseBrowserDelivery(reservation: string): Promise<void> {
    await pluginSql(this.connection).query('DELETE FROM dsh_phalanx.member_browser_reservations WHERE id=$1', [reservation])
  }
  async deferBrowserDelivery(reservation: string): Promise<void> {
    await pluginSql(this.connection).query('UPDATE dsh_phalanx.member_browser_reservations SET owner=NULL WHERE id=$1', [reservation])
  }
  async nativeResourceSnapshot(spaceId: string): Promise<MemberNativeResourceSnapshot> {
    // One statement sees either side of the atomic reservation-to-delivery transfer.
    const rows = await pluginSql(this.connection).query<{
      packageName: string
      version: string
      integrity: string | null
      resourceOrigin: string | null
      browserBindings: InstalledNativeResourceBinding[] | null
      pending: boolean
    }>(
      `SELECT d.package_name AS "packageName",d.version,d.integrity,d.resource_origin AS "resourceOrigin",
         (SELECT jsonb_agg(b.value ORDER BY m.dependency,b.position)
          FROM dsh_phalanx.member_browser_dependencies m
          CROSS JOIN LATERAL jsonb_array_elements(m.bindings) WITH ORDINALITY AS b(value,position)
          WHERE m.space_id=d.space_id AND m.package_name=d.package_name) AS "browserBindings", false AS pending
       FROM dsh_phalanx.plugin_deliveries d WHERE d.space_id=$1
       UNION ALL
       SELECT r.package_name,r.version,r.integrity,r.origin,
         jsonb_agg(b.value ORDER BY r.dependency,b.position), true
       FROM dsh_phalanx.member_browser_reservations r
       CROSS JOIN LATERAL jsonb_array_elements(r.bindings) WITH ORDINALITY AS b(value,position)
       WHERE r.space_id=$1
       GROUP BY r.id,r.package_name,r.version,r.integrity,r.origin
       ORDER BY "packageName",version,integrity,"resourceOrigin","browserBindings"`,
      [spaceId],
    )
    const delivered: MemberNativeResourceSnapshot['delivered'][number][] = []
    const recovering: MemberNativeResourceSnapshot['recovering'][number][] = []
    for (const { packageName, version, integrity, resourceOrigin, browserBindings, pending } of rows) {
      if (pending) {
        if (integrity && resourceOrigin && browserBindings) recovering.push({ packageName, version, integrity, resourceOrigin, browserBindings })
      } else {
        delivered.push({
          packageName,
          version,
          ...(integrity === null ? {} : { integrity }),
          ...(resourceOrigin === null ? {} : { resourceOrigin }),
          ...(browserBindings === null ? {} : { browserBindings }),
        })
      }
    }
    return { delivered, recovering }
  }
  async isBrowserArchiveReserved(spaceId: string, integrity: string): Promise<boolean> {
    const rows = await pluginSql(this.connection).query('SELECT 1 FROM dsh_phalanx.member_browser_reservations WHERE space_id=$1 AND integrity=$2 LIMIT 1', [
      spaceId,
      integrity,
    ])
    return rows.length > 0
  }
  async browserDeliveries(spaceId: string, generation: string) {
    // A missing bundle cannot settle an uncertain install while its original carrier may still commit it.
    return pluginSql(this.connection).query<{ packageName: string; version: string; integrity: string; revision: string }>(
      `SELECT b.package_name AS "packageName",d.version,d.integrity,b.revision FROM dsh_phalanx.member_browser_dependencies b
       INNER JOIN dsh_phalanx.plugin_deliveries d USING(space_id,package_name) WHERE b.space_id=$1
       UNION SELECT package_name,version,integrity,id FROM dsh_phalanx.member_browser_reservations
       WHERE space_id=$1 AND owner IS DISTINCT FROM $2::uuid AND generation IS DISTINCT FROM $3`,
      [spaceId, browserReservationOwner, generation],
    )
  }
  async releaseMissingBrowserDeliveries(spaceId: string, revisions: readonly string[], generation: string): Promise<void> {
    if (!revisions.length) return
    await pluginTransaction(this.connection, async sql => {
      await sql.query('DELETE FROM dsh_phalanx.member_browser_dependencies WHERE space_id=$1 AND revision=ANY($2::uuid[])', [spaceId, revisions])
      await sql.query(
        `DELETE FROM dsh_phalanx.member_browser_reservations WHERE space_id=$1 AND id=ANY($2::uuid[])
         AND owner IS DISTINCT FROM $3::uuid AND generation IS DISTINCT FROM $4`,
        [spaceId, revisions, browserReservationOwner, generation],
      )
    })
  }
  async save(spaceId: string, record: PluginInstallation, browserReservation?: string, expectedServiceGeneration?: string): Promise<void> {
    await pluginTransaction(this.connection, async sql => {
      const { packageName, version, source, integrity, serviceOrigin, resourceOrigin } = record
      let serviceClaim = serviceOrigin
      if (serviceOrigin && expectedServiceGeneration) {
        // Match catalog retirement's lock order: the library owner, then the delivery history.
        const [current] = await sql.query(
          `SELECT package_name FROM dsh_phalanx.plugin_library AS plugin
           WHERE package_name=$1 AND suite_origin=$2 AND ${pluginServiceGeneration}=$3 FOR SHARE`,
          [packageName, serviceOrigin, expectedServiceGeneration],
        )
        if (!current) serviceClaim = undefined
      }
      await sql.query('SELECT package_name FROM dsh_phalanx.plugin_deliveries WHERE space_id=$1 AND package_name=$2 FOR UPDATE', [spaceId, packageName])
      await sql.query(
        `DELETE FROM dsh_phalanx.member_browser_dependencies m USING dsh_phalanx.plugin_deliveries d
         WHERE m.space_id=d.space_id AND m.package_name=d.package_name AND d.space_id=$1 AND d.package_name=$2
         AND ($5::text IS NULL OR d.version IS DISTINCT FROM $3 OR d.integrity IS DISTINCT FROM $4 OR d.resource_origin IS DISTINCT FROM $5)`,
        [spaceId, packageName, version, integrity ?? null, resourceOrigin ?? null],
      )
      await sql.query(
        `INSERT INTO dsh_phalanx.plugin_deliveries(space_id,package_name,version,source,integrity,service_origin,resource_origin) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(space_id,package_name) DO UPDATE SET version=EXCLUDED.version,source=EXCLUDED.source,integrity=EXCLUDED.integrity,service_origin=EXCLUDED.service_origin,resource_origin=EXCLUDED.resource_origin,service_settings=CASE
        WHEN EXCLUDED.service_origin IS NOT NULL AND plugin_deliveries.service_origin=EXCLUDED.service_origin
        THEN plugin_deliveries.service_settings
        ELSE (SELECT jsonb_object_agg(key, value) FROM jsonb_each(plugin_deliveries.service_settings) WHERE value ? 'jsonFiles') END`,
        [spaceId, packageName, version, source, integrity ?? null, serviceClaim ?? null, resourceOrigin ?? null],
      )
      if (browserReservation && resourceOrigin && integrity) {
        const committed = await sql.query(
          `INSERT INTO dsh_phalanx.member_browser_dependencies(space_id,package_name,dependency,bindings,title,playwright_version)
           SELECT space_id,package_name,dependency,bindings,title,playwright_version FROM dsh_phalanx.member_browser_reservations
           WHERE id=$1 AND space_id=$2 AND package_name=$3 AND version=$4 AND integrity=$5 AND origin=$6
           ON CONFLICT(space_id,package_name,dependency) DO UPDATE SET bindings=EXCLUDED.bindings,title=EXCLUDED.title,
             playwright_version=EXCLUDED.playwright_version,revision=gen_random_uuid()
           RETURNING dependency`,
          [browserReservation, spaceId, packageName, version, integrity, resourceOrigin],
        )
        if (!committed.length) throw Error('The prepared browser delivery is unavailable')
        await sql.query('DELETE FROM dsh_phalanx.member_browser_reservations WHERE id=$1', [browserReservation])
      } else if (resourceOrigin && integrity)
        await sql.query(`${insertMemberBrowserDependencies} WHERE d.space_id=$1 AND d.package_name=$2 ON CONFLICT DO NOTHING`, [spaceId, packageName])
      if (!resourceOrigin) await sql.query('DELETE FROM dsh_phalanx.member_browser_reservations WHERE space_id=$1 AND package_name=$2', [spaceId, packageName])
    })
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
  async personalJsonFields(packageName: string, serviceOrigin: string): Promise<readonly { file: string; path: string }[]> {
    return await pluginSql(this.connection).query<{ file: string; path: string }>(
      `SELECT DISTINCT file.key AS file, field.key AS path
       FROM dsh_phalanx.plugin_deliveries delivery
       CROSS JOIN LATERAL jsonb_each(delivery.service_settings->$3::text->'jsonFiles') file
       CROSS JOIN LATERAL jsonb_each(file.value) field
       WHERE delivery.package_name=$1 AND delivery.service_origin=$2 AND field.value->'detached' = 'true'::jsonb`,
      [packageName, serviceOrigin, nativeJsonSettingsHistoryKey],
    )
  }
  async resetForSpace(spaceId: string): Promise<void> {
    await pluginTransaction(this.connection, async sql => {
      await sql.query('DELETE FROM dsh_phalanx.member_browser_reservations WHERE space_id=$1', [spaceId])
      await sql.query('DELETE FROM dsh_phalanx.member_browser_dependencies WHERE space_id=$1', [spaceId])
      await sql.query("DELETE FROM dsh_phalanx.plugin_deliveries WHERE space_id=$1 AND source='preinstall'", [spaceId])
      await sql.query(
        'UPDATE dsh_phalanx.plugin_deliveries SET service_origin=NULL,resource_origin=NULL,service_settings=NULL WHERE space_id=$1 AND (service_origin IS NOT NULL OR resource_origin IS NOT NULL OR service_settings IS NOT NULL)',
        [spaceId],
      )
    })
  }
}
