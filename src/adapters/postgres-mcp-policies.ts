import { randomUUID } from 'node:crypto'
import { BusinessRuleError } from '../domain/business-error.js'
import type { McpGroupPolicy, McpMemberPolicy, McpPolicyRowsPort } from '../ports/mcp-services.js'
import type { PlatformSql } from './platform-database.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'

/** Per-group and per-member revisions preserve configured empty policy sets. */
export class PostgresMcpPolicies implements McpPolicyRowsPort {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async groups(): Promise<readonly McpGroupPolicy[]> {
    const rows = await repositorySql(this.connection).query<{ group_id: string; row_revision: string; names: readonly string[] }>(
      `SELECT settings.*,ARRAY(SELECT service FROM dsh_phalanx.mcp_group_grants WHERE group_id=settings.group_id ORDER BY service) AS names
       FROM dsh_phalanx.mcp_group_settings settings ORDER BY group_id`,
    )
    return rows.map(row => ({ groupId: row.group_id, revision: row.row_revision, names: row.names }))
  }
  async members(): Promise<readonly McpMemberPolicy[]> {
    const rows = await repositorySql(this.connection).query<{
      space_id: string
      row_revision: string
      selections_configured: boolean
      preferences_configured: boolean
      selections: readonly string[]
      preferences: Readonly<Record<string, boolean>>
    }>(`SELECT settings.*,
      ARRAY(SELECT service FROM dsh_phalanx.mcp_selections WHERE space_id=settings.space_id ORDER BY service) AS selections,
      (SELECT COALESCE(jsonb_object_agg(service,enabled),'{}') FROM dsh_phalanx.mcp_preferences WHERE space_id=settings.space_id) AS preferences
      FROM dsh_phalanx.mcp_member_settings settings ORDER BY space_id`)
    return rows.map(row => ({
      spaceId: row.space_id,
      revision: row.row_revision,
      ...(row.selections_configured ? { selections: row.selections } : {}),
      ...(row.preferences_configured ? { preferences: row.preferences } : {}),
    }))
  }
  async saveGroup(group: string, names: readonly string[], expectedRevision: string): Promise<void> {
    await repositoryTransaction(this.connection, async sql => {
      await this.lockServices(sql, names)
      const current = await this.current(sql, 'mcp_group_settings', 'group_id', group, expectedRevision)
      const saved = await sql.query(
        current
          ? 'UPDATE dsh_phalanx.mcp_group_settings SET row_revision=$2 WHERE group_id=$1 RETURNING group_id'
          : 'INSERT INTO dsh_phalanx.mcp_group_settings(group_id,row_revision) VALUES($1,$2) ON CONFLICT(group_id) DO NOTHING RETURNING group_id',
        [group, randomUUID()],
      )
      if (!saved.length) throw this.changed()
      await this.replace(sql, 'mcp_group_grants', 'group_id', group, names)
    })
  }
  async saveMember(
    space: string,
    selections: readonly string[] | undefined,
    preferences: Readonly<Record<string, boolean>> | undefined,
    expectedRevision: string,
  ): Promise<void> {
    if (selections === undefined && preferences === undefined) return this.removeMember(space, expectedRevision)
    await repositoryTransaction(this.connection, async sql => {
      await this.lockServices(sql, [...(selections ?? []), ...Object.keys(preferences ?? {})])
      const current = await this.current(sql, 'mcp_member_settings', 'space_id', space, expectedRevision)
      const saved = await sql.query(
        current
          ? 'UPDATE dsh_phalanx.mcp_member_settings SET row_revision=$2,selections_configured=$3,preferences_configured=$4 WHERE space_id=$1 RETURNING space_id'
          : 'INSERT INTO dsh_phalanx.mcp_member_settings(space_id,row_revision,selections_configured,preferences_configured) VALUES($1,$2,$3,$4) ON CONFLICT(space_id) DO NOTHING RETURNING space_id',
        [space, randomUUID(), selections !== undefined, preferences !== undefined],
      )
      if (!saved.length) throw this.changed()
      await this.replace(sql, 'mcp_selections', 'space_id', space, selections ?? [])
      const names = Object.keys(preferences ?? {})
      await sql.query('DELETE FROM dsh_phalanx.mcp_preferences WHERE space_id=$1 AND NOT(service=ANY($2::text[]))', [space, names])
      for (const [service, enabled] of Object.entries(preferences ?? {}))
        await sql.query(
          `INSERT INTO dsh_phalanx.mcp_preferences(space_id,service,enabled) VALUES($1,$2,$3)
          ON CONFLICT(space_id,service) DO UPDATE SET enabled=EXCLUDED.enabled WHERE mcp_preferences.enabled IS DISTINCT FROM EXCLUDED.enabled`,
          [space, service, enabled],
        )
    })
  }
  async removeGroup(group: string, expectedRevision: string): Promise<void> {
    await repositoryTransaction(this.connection, async sql => {
      await this.current(sql, 'mcp_group_settings', 'group_id', group, expectedRevision)
      await sql.query('DELETE FROM dsh_phalanx.mcp_group_settings WHERE group_id=$1', [group])
    })
  }
  async removeMember(space: string, expectedRevision: string): Promise<void> {
    await repositoryTransaction(this.connection, async sql => {
      await this.current(sql, 'mcp_member_settings', 'space_id', space, expectedRevision)
      await sql.query('DELETE FROM dsh_phalanx.mcp_member_settings WHERE space_id=$1', [space])
    })
  }
  private async lockServices(sql: PlatformSql, names: readonly string[]): Promise<void> {
    const unique = [...new Set(names)].sort()
    const rows = await sql.query('SELECT name FROM dsh_phalanx.mcp_services WHERE name=ANY($1::text[]) ORDER BY name FOR UPDATE', [unique])
    if (rows.length !== unique.length) throw this.changed()
  }
  private async current(
    sql: PlatformSql,
    table: 'mcp_group_settings' | 'mcp_member_settings',
    column: 'group_id' | 'space_id',
    id: string,
    expected: string,
  ): Promise<boolean> {
    const row = (await sql.query<{ row_revision: string }>(`SELECT row_revision FROM dsh_phalanx.${table} WHERE ${column}=$1 FOR UPDATE`, [id]))[0]
    if ((row?.row_revision ?? 'none') !== expected) throw this.changed()
    return !!row
  }
  private async replace(
    sql: PlatformSql,
    table: 'mcp_group_grants' | 'mcp_selections',
    column: 'group_id' | 'space_id',
    id: string,
    names: readonly string[],
  ): Promise<void> {
    await sql.query(`DELETE FROM dsh_phalanx.${table} WHERE ${column}=$1 AND NOT(service=ANY($2::text[]))`, [id, names])
    for (const service of [...new Set(names)])
      await sql.query(`INSERT INTO dsh_phalanx.${table}(${column},service) VALUES($1,$2) ON CONFLICT DO NOTHING`, [id, service])
  }
  private changed() {
    return new BusinessRuleError('conflict', 'Platform configuration changed. Reload before saving.', 'platform-configuration-conflict')
  }
}
