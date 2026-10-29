import { randomUUID } from 'node:crypto'
import { BusinessRuleError } from '../domain/business-error.js'
import { assertExpertInput, type Expert } from '../domain/expert.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'
import { expertRelations, lockExpertParents, replaceExpertRelations } from './expert-relations.js'
import type { ExpertRowsPort } from '../ports/experts.js'
import type { PlatformSql } from './platform-database.js'

interface ExpertRow {
  id: string
  revision: string
  row_revision: string
  published: boolean
  definition: Pick<Expert, 'name' | 'description' | 'icon' | 'persona' | 'examples'>
  skills: readonly string[]
  skillPacks: readonly string[]
  plugins: readonly string[]
  mcp: readonly string[]
  model: Expert['model']
}

/** Ordinary expert definitions are fetched by row; preset and optimistic revisions have separate purposes. */
export class PostgresExpertRows implements ExpertRowsPort {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async get(id: string): Promise<Expert | undefined> {
    return (await this.rows(id))[0]
  }
  list(): Promise<readonly Expert[]> {
    return this.rows()
  }
  lockReferences(experts: readonly Expert[]): Promise<void> {
    return lockExpertParents(repositorySql(this.connection), experts)
  }
  async lock(id: string, expectedRevision: string): Promise<void> {
    const row = (
      await repositorySql(this.connection).query<{ row_revision: string }>('SELECT row_revision FROM dsh_phalanx.experts WHERE id=$1 FOR UPDATE', [id])
    )[0]
    if ((row?.row_revision ?? 'none') !== expectedRevision)
      throw new BusinessRuleError('conflict', 'Expert settings changed. Review them again.', 'expert-stale')
  }
  async remove(id: string, expectedRevision: string): Promise<void> {
    await repositoryTransaction(this.connection, async sql => {
      const connection = { sql, cipher: 'sql' in this.connection ? this.connection.cipher : this.connection.cipher() }
      const rows = new PostgresExpertRows(connection)
      const previous = await rows.get(id)
      if (previous) await rows.lockReferences([previous])
      await rows.lock(id, expectedRevision)
      await this.purgePolicy(sql, 'group', id)
      await this.purgePolicy(sql, 'member', id)
      await sql.query('DELETE FROM dsh_phalanx.experts WHERE id=$1', [id])
    })
  }
  async save(expert: Expert, expectedRevision = expert.rowRevision ?? 'none'): Promise<void> {
    assertExpertInput(expert)
    if (!Number.isSafeInteger(expert.revision) || expert.revision < 1 || typeof expert.published !== 'boolean') throw Error('Invalid expert record')
    const { name, description, icon, persona, examples } = expert
    const values = [expert.id, expert.revision, randomUUID(), expert.published, JSON.stringify({ name, description, icon, persona, examples })]
    await repositoryTransaction(this.connection, async sql => {
      await lockExpertParents(sql, [expert])
      const saved = await sql.query(
        expectedRevision === 'none'
          ? 'INSERT INTO dsh_phalanx.experts(id,revision,row_revision,published,definition) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id'
          : 'UPDATE dsh_phalanx.experts SET revision=$2,row_revision=$3,published=$4,definition=$5 WHERE id=$1 AND row_revision=$6 RETURNING id',
        expectedRevision === 'none' ? values : [...values, expectedRevision],
      )
      if (!saved.length) throw new BusinessRuleError('conflict', 'Expert settings changed. Review them again.', 'expert-stale')
      await replaceExpertRelations(sql, expert)
      if (!expert.published) await this.purgePolicy(sql, 'member', expert.id)
    })
  }
  private async purgePolicy(sql: PlatformSql, scope: 'group' | 'member', id: string): Promise<void> {
    const settings = scope === 'group' ? 'expert_group_settings' : 'expert_member_settings',
      relation = scope === 'group' ? 'expert_grants' : 'expert_selections',
      column = scope === 'group' ? 'group_id' : 'space_id'
    const owners = await sql.query<{ owner_id: string }>(
      `SELECT s.${column} AS owner_id FROM dsh_phalanx.${settings} s WHERE EXISTS(SELECT 1 FROM dsh_phalanx.${relation} r WHERE r.${column}=s.${column} AND r.expert_id=$1) ORDER BY s.${column} FOR UPDATE`,
      [id],
    )
    for (const owner of owners) await sql.query(`UPDATE dsh_phalanx.${settings} SET row_revision=$2 WHERE ${column}=$1`, [owner.owner_id, randomUUID()])
    await sql.query(`DELETE FROM dsh_phalanx.${relation} WHERE expert_id=$1`, [id])
  }
  private async rows(id?: string): Promise<readonly Expert[]> {
    const relations = Object.entries(expertRelations).map(
      ([field, { table }]) =>
        `COALESCE((SELECT jsonb_agg(r.name ORDER BY r.position) FROM dsh_phalanx.${table} r WHERE r.expert_id=e.id),'[]'::jsonb) AS "${field}"`,
    )
    const rows = await repositorySql(this.connection).query<ExpertRow>(
      `SELECT e.*,${relations.join(',')},(SELECT jsonb_build_object('providerId',m.provider_id,'name',m.name) FROM dsh_phalanx.expert_models m WHERE m.expert_id=e.id) AS model FROM dsh_phalanx.experts e${id === undefined ? '' : ' WHERE e.id=$1'} ORDER BY e.id`,
      id === undefined ? [] : [id],
    )
    return rows.map(row => ({
      ...row.definition,
      id: row.id,
      revision: Number(row.revision),
      rowRevision: row.row_revision,
      published: row.published,
      skills: row.skills,
      skillPacks: row.skillPacks,
      plugins: row.plugins,
      mcp: row.mcp,
      model: row.model,
    }))
  }
}
