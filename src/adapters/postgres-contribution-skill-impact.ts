import type { PlatformTransaction } from './postgres-unit-of-work.js'
import { BusinessRuleError } from '../domain/business-error.js'

/** The unchanged preview includes all owner package choices; conflicting writers require a fresh review. */
export class PostgresContributionSkillImpact {
  constructor(private readonly transaction: PlatformTransaction) {}
  async lock(name: string, retireSelections = false): Promise<void> {
    const { sql } = this.transaction
    try {
      await sql.query('SELECT id FROM dsh_phalanx.groups ORDER BY id FOR SHARE NOWAIT')
      if (retireSelections)
        await sql.query(
          `SELECT space_id FROM dsh_phalanx.accounts a WHERE EXISTS(
        SELECT 1 FROM dsh_phalanx.skill_selections s WHERE s.space_id=a.space_id AND s.name=$1) ORDER BY space_id FOR UPDATE NOWAIT`,
          [name],
        )
      await sql.query('SELECT space_id FROM dsh_phalanx.accounts ORDER BY space_id FOR SHARE NOWAIT')
      // Never wait behind a pack writer that may next acquire this skill parent or an owner.
      await sql.query('SELECT name FROM dsh_phalanx.skills WHERE name=$1 FOR UPDATE NOWAIT', [name])
      // Even unrelated pack deletion/rename cascades into the complete choice arrays in the token.
      await sql.query('SELECT name FROM dsh_phalanx.skill_packs ORDER BY name FOR SHARE NOWAIT')
    } catch (error) {
      if (error && typeof error === 'object' && 'sqlState' in error && error.sqlState === '55P03')
        throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
      throw error
    }
  }
}
