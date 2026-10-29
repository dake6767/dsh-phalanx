import { createHash } from 'node:crypto'
import type { ExpertSnapshot } from '../ports/experts.js'
import { repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'
import { PostgresExpertRows } from './postgres-expert-rows.js'
import { PostgresExpertPolicies } from './postgres-expert-policies.js'
import { PostgresExpertMetadata } from './postgres-expert-metadata.js'

/** One request-local consistent read; ordinary queries never retain expert facts. */
export class PostgresExpertStateQuery {
  constructor(private readonly connection: RowRepositoryConnection) {}
  read(): Promise<ExpertSnapshot> {
    return repositoryTransaction(this.connection, async sql => {
      if (!('sql' in this.connection)) await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const connection = { sql, cipher: 'sql' in this.connection ? this.connection.cipher : this.connection.cipher() }
      const experts = await new PostgresExpertRows(connection).list()
      const groups = await new PostgresExpertPolicies(connection, 'group').list(),
        members = await new PostgresExpertPolicies(connection, 'member').list()
      const parents = [
        await sql.query('SELECT username,space_id,group_id,admin,disabled,session_epoch FROM dsh_phalanx.accounts ORDER BY space_id'),
        await sql.query('SELECT id FROM dsh_phalanx.groups ORDER BY id'),
      ]
      const state = {
        experts,
        grants: Object.fromEntries(groups.map(row => [row.ownerId, row.names])),
        selections: Object.fromEntries(members.map(row => [row.ownerId, row.names])),
        revision: await new PostgresExpertMetadata(connection).generation(),
        versions: {
          experts: Object.fromEntries(experts.map(row => [row.id, row.rowRevision!])),
          groups: Object.fromEntries(groups.map(row => [row.ownerId, row.revision])),
          members: Object.fromEntries(members.map(row => [row.ownerId, row.revision])),
        },
        parentRevision: createHash('sha256').update(JSON.stringify(parents)).digest('hex'),
      }
      return { ...state, publicRevision: createHash('sha256').update(JSON.stringify(state)).digest('hex') }
    })
  }
}
