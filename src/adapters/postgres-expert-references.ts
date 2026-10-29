import { createHash, randomUUID } from 'node:crypto'
import { BusinessRuleError } from '../domain/business-error.js'
import type { ExpertReferenceImpact, ExpertReferenceTarget } from '../domain/expert-reference.js'
import type { ExpertReferencesPort, ExpertReferenceMutationsPort } from '../ports/experts.js'
import type { PlatformSql } from './platform-database.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'
import { expertRelations } from './expert-relations.js'

interface AffectedExpert {
  id: string
  name: string
  row_revision: string
}

/** Parent deletion and expert reference retirement share the caller's unit of work. */
export class PostgresExpertReferences implements ExpertReferencesPort, ExpertReferenceMutationsPort {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async impact(targets: readonly ExpertReferenceTarget[]): Promise<ExpertReferenceImpact> {
    return this.summary(targets, await this.affected(repositorySql(this.connection), targets))
  }
  async lockImpact(targets: readonly ExpertReferenceTarget[]): Promise<ExpertReferenceImpact> {
    if (!('sql' in this.connection)) throw Error('Expert impact locks require a transaction')
    await this.affected(this.connection.sql, targets, true)
    return this.impact(targets)
  }
  async touch(targets: readonly ExpertReferenceTarget[]): Promise<void> {
    await this.change(targets, false)
  }
  async detach(targets: readonly ExpertReferenceTarget[], expectedRevision?: string): Promise<void> {
    await this.change(targets, true, expectedRevision)
  }
  private async change(targets: readonly ExpertReferenceTarget[], detach: boolean, expectedRevision?: string): Promise<void> {
    await repositoryTransaction(this.connection, async sql => {
      for (const relation of Object.values(expertRelations)) {
        const names = [...new Set(targets.filter(target => target.kind === relation.kind).map(target => target.name))].sort()
        if (names.length)
          await sql.query(
            `SELECT ${relation.column} FROM dsh_phalanx.${relation.parent} WHERE ${relation.column}=ANY($1::text[]) ORDER BY ${relation.column} FOR UPDATE`,
            [names],
          )
      }
      await this.affected(sql, targets, true)
      // A lock wait may have observed a newer tuple; read metadata after all locks are held.
      const affected = await this.affected(sql, targets)
      if (expectedRevision !== undefined && this.summary(targets, affected).revision !== expectedRevision)
        throw new BusinessRuleError('conflict', 'Expert references changed. Review the deletion impact again.', 'expert-stale')
      if (detach)
        for (const relation of Object.values(expertRelations)) {
          const names = [...new Set(targets.filter(target => target.kind === relation.kind).map(target => target.name))]
          if (names.length) await sql.query(`DELETE FROM dsh_phalanx.${relation.table} WHERE name=ANY($1::text[])`, [names])
        }
      for (const expert of affected)
        await sql.query('UPDATE dsh_phalanx.experts SET revision=revision+1,row_revision=$2 WHERE id=$1', [expert.id, randomUUID()])
    })
  }
  private summary(targets: readonly ExpertReferenceTarget[], rows: readonly AffectedExpert[]): ExpertReferenceImpact {
    return {
      experts: rows.map(row => ({ id: row.id, name: row.name })),
      revision: createHash('sha256')
        .update(JSON.stringify([[...new Set(targets.map(target => JSON.stringify([target.kind, target.name])))].sort(), rows]))
        .digest('hex'),
    }
  }
  private affected(sql: PlatformSql, targets: readonly ExpertReferenceTarget[], lock = false): Promise<readonly AffectedExpert[]> {
    const parameters: string[][] = [],
      queries: string[] = []
    for (const relation of Object.values(expertRelations)) {
      const names = [...new Set(targets.filter(target => target.kind === relation.kind).map(target => target.name))]
      if (!names.length) continue
      parameters.push(names)
      queries.push(`SELECT expert_id FROM dsh_phalanx.${relation.table} WHERE name=ANY($${parameters.length}::text[])`)
    }
    if (!queries.length) return Promise.resolve([])
    return sql.query<AffectedExpert>(
      `SELECT e.id,e.definition->>'name' AS name,e.row_revision FROM dsh_phalanx.experts e WHERE e.id IN (${queries.join(' UNION ')}) ORDER BY e.id${lock ? ' FOR UPDATE' : ''}`,
      parameters,
    )
  }
}
