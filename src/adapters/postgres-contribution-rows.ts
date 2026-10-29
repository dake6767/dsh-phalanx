import { contributionNameLock } from './advisory-locks.js'
import { randomUUID } from 'node:crypto'
import type { MemberContribution } from '../domain/member-contribution.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { ContributionRecord, ContributionRows } from '../ports/contribution-rows.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'

interface Row extends Record<string, unknown> {
  record: MemberContribution
  row_revision: string
}
/** Each contribution owns an optimistic row; author identity remains in its historical record. */
export class PostgresContributionRows implements ContributionRows {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async lockName(kind: 'skill' | 'plugin', name: string): Promise<void> {
    await repositorySql(this.connection).query(contributionNameLock, [kind, name])
  }
  async get(id: string): Promise<ContributionRecord | undefined> {
    const row = (await repositorySql(this.connection).query<Row>('SELECT record,row_revision FROM dsh_phalanx.contributions WHERE id=$1', [id]))[0]
    return row ? { row: row.record, revision: row.row_revision } : undefined
  }
  async list(): Promise<readonly ContributionRecord[]> {
    return (await repositorySql(this.connection).query<Row>('SELECT record,row_revision FROM dsh_phalanx.contributions ORDER BY id')).map(row => ({
      row: row.record,
      revision: row.row_revision,
    }))
  }
  async lock(id: string, expectedRevision: string): Promise<MemberContribution> {
    const row = (await repositorySql(this.connection).query<Row>('SELECT record,row_revision FROM dsh_phalanx.contributions WHERE id=$1 FOR UPDATE', [id]))[0]
    if (!row || row.row_revision !== expectedRevision) throw this.changed()
    return row.record
  }
  async save(input: MemberContribution, expectedRevision = 'none'): Promise<void> {
    const row = structuredClone(input)
    await repositoryTransaction(this.connection, async sql => {
      const account = (
        await sql.query<{ space_id: string }>('SELECT space_id FROM dsh_phalanx.accounts WHERE space_id=$1 AND username=$2 FOR KEY SHARE', [
          row.contributor.spaceId,
          row.contributor.username,
        ])
      )[0]
      if (row.status === 'pending' && !account) throw this.changed()
      const previous = (await sql.query<Row>('SELECT record,row_revision FROM dsh_phalanx.contributions WHERE id=$1 FOR UPDATE', [row.id]))[0]
      if ((previous?.row_revision ?? 'none') !== expectedRevision) throw this.changed()
      const parameters = [row.id, row.kind ?? 'skill', row.name, row.status, account?.space_id ?? null, JSON.stringify(row), randomUUID()]
      const saved = await sql.query(
        previous
          ? 'UPDATE dsh_phalanx.contributions SET kind=$2,name=$3,status=$4,live_space_id=$5,record=$6,row_revision=$7 WHERE id=$1 RETURNING id'
          : 'INSERT INTO dsh_phalanx.contributions(id,kind,name,status,live_space_id,record,row_revision) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id',
        parameters,
      )
      if (!saved.length) throw this.changed()
    })
  }
  async remove(id: string, expectedRevision: string): Promise<void> {
    await repositoryTransaction(this.connection, async sql => {
      const rows = new PostgresContributionRows({ sql, cipher: 'sql' in this.connection ? this.connection.cipher : this.connection.cipher() })
      await rows.lock(id, expectedRevision)
      await sql.query('DELETE FROM dsh_phalanx.contributions WHERE id=$1', [id])
    })
  }
  private changed() {
    return new BusinessRuleError('conflict', 'This contribution changed. Review it again.', 'contribution-unavailable')
  }
}
