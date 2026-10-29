import type { Expert } from '../domain/expert.js'
import type { PlatformSql } from './platform-database.js'
import { BusinessRuleError } from '../domain/business-error.js'

/** A separate foreign key for each capability, with stable names only for model choices. */
export const expertRelations = {
  skills: { kind: 'skill', table: 'expert_skills', parent: 'skills', column: 'name' },
  skillPacks: { kind: 'pack', table: 'expert_skill_packs', parent: 'skill_packs', column: 'name' },
  plugins: { kind: 'plugin', table: 'expert_plugins', parent: 'plugin_library', column: 'package_name' },
  mcp: { kind: 'mcp', table: 'expert_mcp', parent: 'mcp_services', column: 'name' },
} as const

/** Every writer locks all capability parents before acquiring expert rows. */
export async function lockExpertParents(sql: PlatformSql, experts: readonly Expert[]): Promise<void> {
  for (const [field, relation] of Object.entries(expertRelations)) {
    const names = [...new Set(experts.flatMap(expert => expert[field as keyof typeof expertRelations]))].sort()
    if (!names.length) continue
    const parents = await sql.query(
      `SELECT ${relation.column} FROM dsh_phalanx.${relation.parent} WHERE ${relation.column}=ANY($1::text[]) ORDER BY ${relation.column} FOR KEY SHARE`,
      [names],
    )
    if (parents.length !== names.length) throw new BusinessRuleError('conflict', 'Expert references changed. Review them again.', 'expert-stale')
  }
}

export async function replaceExpertRelations(sql: PlatformSql, expert: Expert): Promise<void> {
  for (const [field, { table }] of Object.entries(expertRelations)) {
    const names = expert[field as keyof typeof expertRelations]
    await sql.query(`DELETE FROM dsh_phalanx.${table} WHERE expert_id=$1 AND NOT(name=ANY($2::text[]))`, [expert.id, names])
    for (const [position, name] of names.entries())
      await sql.query(
        `INSERT INTO dsh_phalanx.${table}(expert_id,name,position) VALUES($1,$2,$3)
         ON CONFLICT(expert_id,name) DO UPDATE SET position=EXCLUDED.position WHERE ${table}.position IS DISTINCT FROM EXCLUDED.position`,
        [expert.id, name, position],
      )
  }
  if (expert.model)
    await sql.query(
      `INSERT INTO dsh_phalanx.expert_models(expert_id,provider_id,name) VALUES($1,$2,$3)
       ON CONFLICT(expert_id) DO UPDATE SET provider_id=EXCLUDED.provider_id,name=EXCLUDED.name
       WHERE (expert_models.provider_id,expert_models.name) IS DISTINCT FROM (EXCLUDED.provider_id,EXCLUDED.name)`,
      [expert.id, expert.model.providerId, expert.model.name],
    )
  else await sql.query('DELETE FROM dsh_phalanx.expert_models WHERE expert_id=$1', [expert.id])
}
