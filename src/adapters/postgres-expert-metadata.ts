import { repositorySql, type RowRepositoryConnection } from './postgres-row-repository.js'

/** A library change sequence is not a global optimistic lock over independent experts. */
export class PostgresExpertMetadata {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async generation(): Promise<number> {
    const row = (await repositorySql(this.connection).query<{ generation: string }>('SELECT generation FROM dsh_phalanx.expert_metadata WHERE id=1'))[0]
    return Number(row?.generation ?? 0)
  }
  async advance(): Promise<void> {
    await repositorySql(this.connection).query('UPDATE dsh_phalanx.expert_metadata SET generation=generation+1 WHERE id=1')
  }
}
