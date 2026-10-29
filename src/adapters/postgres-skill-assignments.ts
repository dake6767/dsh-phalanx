import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import type { SkillAssignmentsPort } from '../ports/member-skills.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'

export type SkillAssignmentKind = 'skills' | 'packs'
export type SkillAssignmentScope = 'grants' | 'selections'
const carriers = {
  skills: { grants: 'skill_group_grants', selections: 'skill_selections', receipts: 'skill_grant_receipts' },
  packs: { grants: 'pack_group_grants', selections: 'pack_selections', receipts: 'pack_grant_receipts' },
} as const

/** Separate group and space relations; contribution receipts outlive revocation of a grant. */
export class PostgresSkillAssignments implements SkillAssignmentsPort {
  readonly contributionReceipt?: (id: string, name: string) => Promise<ContributionReceipt | undefined>
  readonly grantContribution?: (id: string, name: string, receipt: ContributionReceipt) => Promise<void>
  private readonly table: string
  private readonly key: 'group_id' | 'space_id'
  constructor(
    private readonly connection: RowRepositoryConnection,
    kind: SkillAssignmentKind,
    private readonly scope: SkillAssignmentScope,
  ) {
    this.table = carriers[kind][scope]
    this.key = scope === 'grants' ? 'group_id' : 'space_id'
    if (scope === 'grants') {
      const receipts = carriers[kind].receipts
      this.contributionReceipt = async (id, name) =>
        (
          await repositorySql(connection).query<{ receipt: ContributionReceipt }>(`SELECT receipt FROM dsh_phalanx.${receipts} WHERE group_id=$1 AND name=$2`, [
            id,
            name,
          ])
        )[0]?.receipt
      this.grantContribution = async (id, name, receipt) => {
        await repositoryTransaction(connection, async sql => {
          await sql.query('SELECT id FROM dsh_phalanx.groups WHERE id=$1 FOR UPDATE', [id])
          await sql.query(`INSERT INTO dsh_phalanx.${this.table}(group_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING`, [id, name])
          await sql.query(
            `INSERT INTO dsh_phalanx.${receipts}(group_id,name,receipt) VALUES($1,$2,$3) ON CONFLICT(group_id,name) DO UPDATE SET receipt=EXCLUDED.receipt`,
            [id, name, JSON.stringify(receipt)],
          )
        })
      }
    }
  }
  async get(id: string): Promise<readonly string[]> {
    return (
      await repositorySql(this.connection).query<{ name: string }>(`SELECT name FROM dsh_phalanx.${this.table} WHERE ${this.key}=$1 ORDER BY name`, [id])
    ).map(row => row.name)
  }
  async set(id: string, names: readonly string[]): Promise<void> {
    await repositoryTransaction(this.connection, async sql => {
      if (this.scope === 'grants') await sql.query('SELECT id FROM dsh_phalanx.groups WHERE id=$1 FOR UPDATE', [id])
      else await sql.query('SELECT space_id FROM dsh_phalanx.accounts WHERE space_id=$1 FOR UPDATE', [id])
      await sql.query(`DELETE FROM dsh_phalanx.${this.table} WHERE ${this.key}=$1 AND NOT(name=ANY($2::text[]))`, [id, names])
      for (const name of new Set(names))
        await sql.query(`INSERT INTO dsh_phalanx.${this.table}(${this.key},name) VALUES($1,$2) ON CONFLICT DO NOTHING`, [id, name])
    })
  }
  async retain(ids: readonly string[], names: readonly string[]): Promise<void> {
    const owners = [...ids],
      retained = [...names]
    await repositoryTransaction(this.connection, async sql => {
      const table = this.scope === 'grants' ? 'groups' : 'accounts',
        column = this.scope === 'grants' ? 'id' : 'space_id'
      await sql.query(
        `SELECT ${column} FROM dsh_phalanx.${table} o WHERE EXISTS(
        SELECT 1 FROM dsh_phalanx.${this.table} r WHERE r.${this.key}=o.${column} AND (NOT(r.${this.key}=ANY($1::text[])) OR NOT(r.name=ANY($2::text[]))))
        ORDER BY ${column} FOR UPDATE`,
        [owners, retained],
      )
      await sql.query(`DELETE FROM dsh_phalanx.${this.table} WHERE NOT(${this.key}=ANY($1::text[])) OR NOT(name=ANY($2::text[]))`, [owners, retained])
    })
  }
}
