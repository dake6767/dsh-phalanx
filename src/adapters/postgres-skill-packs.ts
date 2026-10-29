import { BusinessRuleError } from '../domain/business-error.js'
import type { SkillPack } from '../domain/skill-pack.js'
import type { SkillPackStorePort } from '../ports/skill-packs.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'
import type { PlatformSql } from './platform-database.js'

/** Pack names own their relations; PostgreSQL carries references across a rename. */
export class PostgresSkillPackStore implements SkillPackStorePort {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async list(): Promise<readonly SkillPack[]> {
    const rows = await repositorySql(this.connection).query<{
      name: string
      description: string
      instructions: string
      published: boolean
      suite_origin: string | null
      note: NonNullable<SkillPack['note']> | null
      revision: string
      skills: string[]
    }>(
      `SELECT p.*,COALESCE((SELECT jsonb_agg(m.skill_name ORDER BY m.position) FROM dsh_phalanx.skill_pack_members m WHERE m.pack_name=p.name),'[]'::jsonb) AS skills FROM dsh_phalanx.skill_packs p ORDER BY p.name`,
    )
    return rows.map(row => ({
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      published: row.published,
      skills: row.skills,
      rowRevision: Number(row.revision),
      ...(row.suite_origin === null ? {} : { suiteOrigin: row.suite_origin }),
      ...(row.note === null ? {} : { note: row.note }),
    }))
  }
  async save(pack: SkillPack, expectedRevision: number | 'none' | undefined = pack.rowRevision): Promise<void> {
    await repositoryTransaction(this.connection, async sql => {
      const values = this.values(pack)
      const saved = await sql.query(
        expectedRevision === undefined || expectedRevision === 'none'
          ? `INSERT INTO dsh_phalanx.skill_packs(name,description,instructions,published,suite_origin,note) VALUES($1,$2,$3,$4,$5,$6) ${expectedRevision === 'none' ? 'ON CONFLICT(name) DO NOTHING' : 'ON CONFLICT(name) DO UPDATE SET description=EXCLUDED.description,instructions=EXCLUDED.instructions,published=EXCLUDED.published,suite_origin=EXCLUDED.suite_origin,note=EXCLUDED.note,revision=skill_packs.revision+1'} RETURNING revision`
          : `UPDATE dsh_phalanx.skill_packs SET description=$2,instructions=$3,published=$4,suite_origin=$5,note=$6,revision=revision+1 WHERE name=$1 AND revision=$7 RETURNING revision`,
        expectedRevision === undefined || expectedRevision === 'none' ? values : [...values, expectedRevision],
      )
      if (!saved.length) throw this.changed()
      await this.members(sql, pack)
    })
  }
  async rename(previous: string, pack: SkillPack): Promise<void> {
    if (previous === pack.name) return await this.save(pack)
    await repositoryTransaction(this.connection, async sql => {
      const saved = await sql.query(
        `UPDATE dsh_phalanx.skill_packs SET name=$1,description=$2,instructions=$3,published=$4,suite_origin=$5,note=$6,revision=revision+1 WHERE name=$7 AND ($8::bigint IS NULL OR revision=$8) RETURNING revision`,
        [...this.values(pack), previous, pack.rowRevision ?? null],
      )
      if (!saved.length) throw this.changed()
      await this.members(sql, pack)
    })
  }
  async remove(name: string, expectedRevision?: number): Promise<void> {
    const removed = await repositorySql(this.connection).query(
      expectedRevision === undefined
        ? 'DELETE FROM dsh_phalanx.skill_packs WHERE name=$1 RETURNING name'
        : 'DELETE FROM dsh_phalanx.skill_packs WHERE name=$1 AND revision=$2 RETURNING name',
      expectedRevision === undefined ? [name] : [name, expectedRevision],
    )
    if (expectedRevision !== undefined && !removed.length) throw this.changed()
  }
  private values(pack: SkillPack) {
    return [pack.name, pack.description, pack.instructions, pack.published, pack.suiteOrigin ?? null, pack.note ? JSON.stringify(pack.note) : null]
  }
  private async members(sql: PlatformSql, pack: SkillPack): Promise<void> {
    await sql.query('DELETE FROM dsh_phalanx.skill_pack_members WHERE pack_name=$1 AND NOT(skill_name=ANY($2::text[]))', [pack.name, pack.skills])
    for (const [position, name] of pack.skills.entries())
      await sql.query(
        `INSERT INTO dsh_phalanx.skill_pack_members(pack_name,skill_name,position) VALUES($1,$2,$3) ON CONFLICT(pack_name,skill_name) DO UPDATE SET position=EXCLUDED.position WHERE skill_pack_members.position IS DISTINCT FROM EXCLUDED.position`,
        [pack.name, name, position],
      )
  }
  private changed() {
    return new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
  }
}
