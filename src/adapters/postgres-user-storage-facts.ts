import { UserStorageBindingChanged, type UserStorageBinding, type UserStorageRecord } from '../domain/user-storage.js'
import type { UserStorageFacts } from '../ports/user-storage-facts.js'
import type { PlatformSql } from './platform-database.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'

/** Storage ownership is platform-wide and survives all member-space deletion. */
export class PostgresUserStorageFacts implements UserStorageFacts {
  constructor(private readonly connection: RowRepositoryConnection) {}
  read(): Promise<UserStorageRecord | undefined> {
    return readStorage(repositorySql(this.connection))
  }
  async createOwner(candidate: string): Promise<UserStorageRecord> {
    if (!/^[a-f0-9]{32}$/u.test(candidate)) throw new Error('Invalid platform storage identity')
    return await repositoryTransaction(this.connection, async sql => {
      await sql.query('INSERT INTO dsh_phalanx.user_storage_identity(id,owner,revision) VALUES(1,$1,0) ON CONFLICT(id) DO NOTHING', [candidate])
      return (await readStorage(sql))!
    })
  }
  async saveBinding(expectedRevision: number, binding: UserStorageBinding | null): Promise<UserStorageRecord> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new UserStorageBindingChanged()
    if (binding && (!binding.path || !binding.mount || !/^[a-f0-9]{32}$/u.test(binding.id))) throw new Error('Invalid user storage binding')
    return await repositoryTransaction(this.connection, async sql => {
      const rows = await sql.query('UPDATE dsh_phalanx.user_storage_identity SET revision=revision+1 WHERE id=1 AND revision=$1 RETURNING id', [
        expectedRevision,
      ])
      if (!rows.length) throw new UserStorageBindingChanged()
      if (binding)
        await sql.query(
          `INSERT INTO dsh_phalanx.user_storage_binding(id,path,storage_id,mount) VALUES(1,$1,$2,$3)
        ON CONFLICT(id) DO UPDATE SET path=EXCLUDED.path,storage_id=EXCLUDED.storage_id,mount=EXCLUDED.mount`,
          [binding.path, binding.id, binding.mount],
        )
      else await sql.query('DELETE FROM dsh_phalanx.user_storage_binding WHERE id=1')
      return (await readStorage(sql))!
    })
  }
}

async function readStorage(sql: PlatformSql): Promise<UserStorageRecord | undefined> {
  const row = (
    await sql.query<{ owner: string; revision: string; path: string | null; storage_id: string | null; mount: string | null }>(
      `SELECT i.owner,i.revision,b.path,b.storage_id,b.mount FROM dsh_phalanx.user_storage_identity i
      LEFT JOIN dsh_phalanx.user_storage_binding b ON b.id=i.id WHERE i.id=1`,
    )
  )[0]
  return row
    ? { owner: row.owner, revision: Number(row.revision), binding: row.path === null ? null : { path: row.path, id: row.storage_id!, mount: row.mount! } }
    : undefined
}
