import { randomUUID } from 'node:crypto'
import { BusinessRuleError } from '../domain/business-error.js'
import type { ExpertAssignment, ExpertAssignmentsPort } from '../ports/experts.js'
import type { PlatformSql } from './platform-database.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'

const scopes = {
  group: { settings: 'expert_group_settings', relation: 'expert_grants', column: 'group_id', parent: 'groups', parentKey: 'id' },
  member: { settings: 'expert_member_settings', relation: 'expert_selections', column: 'space_id', parent: 'accounts', parentKey: 'space_id' },
} as const

/** Configured empty grants and selections retain independent owner revisions. */
export class PostgresExpertPolicies implements ExpertAssignmentsPort {
  constructor(
    private readonly connection: RowRepositoryConnection,
    private readonly scope: keyof typeof scopes,
  ) {}
  async lockOwner(ownerId: string, required = true): Promise<void> {
    const { parent, parentKey } = scopes[this.scope]
    const owner = await repositorySql(this.connection).query(`SELECT ${parentKey} FROM dsh_phalanx.${parent} WHERE ${parentKey}=$1 FOR KEY SHARE`, [ownerId])
    if (required && !owner.length) throw this.changed()
  }
  async list(): Promise<readonly ExpertAssignment[]> {
    const { settings, relation, column } = scopes[this.scope]
    const rows = await repositorySql(this.connection).query<{ owner_id: string; row_revision: string; names: string[] }>(
      `SELECT s.${column} AS owner_id,s.row_revision,ARRAY(SELECT expert_id FROM dsh_phalanx.${relation} r WHERE r.${column}=s.${column} ORDER BY expert_id) AS names FROM dsh_phalanx.${settings} s ORDER BY s.${column}`,
    )
    return rows.map(row => ({ ownerId: row.owner_id, revision: row.row_revision, names: row.names }))
  }
  async save(ownerId: string, names: readonly string[], expectedRevision: string): Promise<void> {
    const { settings, relation, column } = scopes[this.scope]
    await repositoryTransaction(this.connection, async sql => {
      const connection = { sql, cipher: 'sql' in this.connection ? this.connection.cipher : this.connection.cipher() }
      await new PostgresExpertPolicies(connection, this.scope).lockOwner(ownerId)
      const unique = [...new Set(names)].sort()
      const experts = await sql.query<{ id: string; published: boolean }>(
        'SELECT id,published FROM dsh_phalanx.experts WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
        [unique],
      )
      if (experts.length !== unique.length || (this.scope === 'member' && experts.some(row => !row.published))) throw this.changed()
      const current = await this.current(sql, ownerId, expectedRevision)
      const saved = await sql.query(
        current
          ? `UPDATE dsh_phalanx.${settings} SET row_revision=$2 WHERE ${column}=$1 RETURNING ${column}`
          : `INSERT INTO dsh_phalanx.${settings}(${column},row_revision) VALUES($1,$2) ON CONFLICT(${column}) DO NOTHING RETURNING ${column}`,
        [ownerId, randomUUID()],
      )
      if (!saved.length) throw this.changed()
      await sql.query(`DELETE FROM dsh_phalanx.${relation} WHERE ${column}=$1 AND NOT(expert_id=ANY($2::text[]))`, [ownerId, unique])
      for (const id of unique) await sql.query(`INSERT INTO dsh_phalanx.${relation}(${column},expert_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [ownerId, id])
    })
  }
  async remove(ownerId: string, expectedRevision: string): Promise<void> {
    const { settings, column } = scopes[this.scope]
    await repositoryTransaction(this.connection, async sql => {
      await this.current(sql, ownerId, expectedRevision)
      await sql.query(`DELETE FROM dsh_phalanx.${settings} WHERE ${column}=$1`, [ownerId])
    })
  }
  private async current(sql: PlatformSql, ownerId: string, expected: string): Promise<boolean> {
    const { settings, column } = scopes[this.scope]
    const row = (await sql.query<{ row_revision: string }>(`SELECT row_revision FROM dsh_phalanx.${settings} WHERE ${column}=$1 FOR UPDATE`, [ownerId]))[0]
    if ((row?.row_revision ?? 'none') !== expected) throw this.changed()
    return !!row
  }
  private changed() {
    return new BusinessRuleError('conflict', 'Expert ownership changed. Review it again.', 'expert-stale')
  }
}
