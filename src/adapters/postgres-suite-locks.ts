import { BusinessRuleError } from '../domain/business-error.js'
import type { SuiteFactLocks } from '../ports/suite-unit-of-work.js'
import type { PlatformTransaction } from './postgres-unit-of-work.js'
import { executionCommandLock, runtimeCommandLock } from './advisory-locks.js'

/** Multi-item plans acquire command namespaces once, before their capability parents. */
export class PostgresSuiteLocks implements SuiteFactLocks {
  constructor(private readonly transaction: PlatformTransaction) {}
  async acquire(input: Parameters<SuiteFactLocks['acquire']>[0]): Promise<void> {
    const { sql } = this.transaction
    for (const command of [...new Set(input.runtimeCommands)].sort()) await sql.query(runtimeCommandLock, [command])
    for (const command of [...new Set(input.executionCommands)].sort()) await sql.query(executionCommandLock, [command])
    const owners = (lock = false) =>
      sql.query<{ space_id: string }>(
        `SELECT a.space_id FROM dsh_phalanx.accounts a WHERE
       EXISTS(SELECT 1 FROM dsh_phalanx.skill_selections s WHERE s.space_id=a.space_id AND s.name=ANY($1::text[])) OR
       EXISTS(SELECT 1 FROM dsh_phalanx.pack_selections s WHERE s.space_id=a.space_id AND s.name=ANY($2::text[])) OR
       EXISTS(SELECT 1 FROM dsh_phalanx.plugin_choices s WHERE s.space_id=a.space_id AND s.package_name=ANY($3::text[]))
       ORDER BY a.space_id${lock ? ' FOR UPDATE NOWAIT' : ''}`,
        [input.skills, input.packs, input.plugins],
      )
    try {
      const lockedOwners = input.retiringChoices ? new Set((await owners(true)).map(row => row.space_id)) : undefined
      for (const [table, column, names] of [
        ['runtime_dependencies', 'name', input.runtime],
        ['skills', 'name', input.skills],
        ['skill_packs', 'name', input.packs],
        ['plugin_library', 'package_name', input.plugins],
      ] as const) {
        if (names.length)
          await sql.query(`SELECT ${column} FROM dsh_phalanx.${table} WHERE ${column}=ANY($1::text[]) ORDER BY ${column} FOR UPDATE NOWAIT`, [
            [...new Set(names)].sort(),
          ])
      }
      if (lockedOwners && (await owners()).some(row => !lockedOwners.has(row.space_id)))
        throw new BusinessRuleError('conflict', 'Catalog choices changed. Review the task again.', 'suite-task-running')
    } catch (error) {
      if (error && typeof error === 'object' && 'sqlState' in error && error.sqlState === '55P03')
        throw new BusinessRuleError('conflict', 'Catalog facts changed. Review the task again.', 'suite-task-running')
      throw error
    }
  }
}
