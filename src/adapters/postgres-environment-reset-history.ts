import type { EnvironmentResetHistory } from '../domain/environment-reset-history.js'
import type { EnvironmentResetHistoryPort } from '../ports/environment-reset-history.js'
import { repositorySql, type RowRepositoryConnection } from './postgres-row-repository.js'

/** The use case holds the target account lock while reading and accepting one request. */
export class PostgresEnvironmentResetHistory implements EnvironmentResetHistoryPort {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async get(spaceId: string): Promise<EnvironmentResetHistory | undefined> {
    const row = (
      await repositorySql(this.connection).query<{
        last_member_accepted_at: string | null
        recent_at: string
        recent_username: string
        recent_role: 'admin' | 'member'
      }>('SELECT last_member_accepted_at,recent_at,recent_username,recent_role FROM dsh_phalanx.environment_reset_history WHERE space_id=$1', [spaceId])
    )[0]
    return row
      ? {
          ...(row.last_member_accepted_at === null ? {} : { lastMemberAcceptedAt: Number(row.last_member_accepted_at) }),
          recent: { at: Number(row.recent_at), username: row.recent_username, role: row.recent_role },
        }
      : undefined
  }
  async save(spaceId: string, record: EnvironmentResetHistory): Promise<void> {
    await repositorySql(this.connection).query(
      `INSERT INTO dsh_phalanx.environment_reset_history
      (space_id,last_member_accepted_at,recent_at,recent_username,recent_role) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(space_id) DO UPDATE SET last_member_accepted_at=EXCLUDED.last_member_accepted_at,
      recent_at=EXCLUDED.recent_at,recent_username=EXCLUDED.recent_username,recent_role=EXCLUDED.recent_role`,
      [spaceId, record.lastMemberAcceptedAt ?? null, record.recent.at, record.recent.username, record.recent.role],
    )
  }
}
