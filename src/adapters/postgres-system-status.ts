import { BusinessRuleError } from '../domain/business-error.js'
import { PlatformDatabaseError } from '../domain/platform-database.js'
import type { CommunitySystemStatusView } from '../domain/system-status-contract.js'
import type { CommunitySystemStatusPort } from '../ports/community-system-status.js'
import type { PlatformDatabase, PlatformSql } from './platform-database.js'

/** Backup confirmation belongs to the selected database, never to a browser or local preference file. */
export class PostgresSystemStatus implements CommunitySystemStatusPort {
  constructor(
    private readonly database: PlatformDatabase,
    private readonly kind: () => 'builtin' | 'external',
  ) {}
  read(): Promise<CommunitySystemStatusView> {
    return this.database.transaction(sql => this.view(sql))
  }
  confirmBackup(fingerprint: string, actor: { readonly username: string; readonly spaceId: string }): Promise<CommunitySystemStatusView> {
    return this.database.transaction(async sql => {
      const [current] = await sql.query<{ fingerprint: string }>(
        "SELECT registry->>'masterFingerprint' AS fingerprint FROM dsh_phalanx.platform_security WHERE id=1 FOR UPDATE",
      )
      if (current?.fingerprint !== fingerprint)
        throw new BusinessRuleError('conflict', 'The master key changed. Refresh its fingerprint before confirming the offline backup.', 'master-key-changed')
      await sql.query(
        `INSERT INTO dsh_phalanx.master_key_backups(fingerprint,username,space_id) VALUES($1,$2,$3)
        ON CONFLICT(fingerprint) DO UPDATE SET username=excluded.username,space_id=excluded.space_id,confirmed_at=now()`,
        [fingerprint, actor.username, actor.spaceId],
      )
      return await this.view(sql)
    })
  }
  private async view(sql: PlatformSql): Promise<CommunitySystemStatusView> {
    const [row] = await sql.query<{ fingerprint: string; username: string | null; space_id: string | null; confirmed_at: Date | null; version: string }>(
      `SELECT s.registry->>'masterFingerprint' AS fingerprint,b.username,b.space_id,b.confirmed_at,current_setting('server_version') AS version
        FROM dsh_phalanx.platform_security s LEFT JOIN dsh_phalanx.master_key_backups b ON b.fingerprint=s.registry->>'masterFingerprint' WHERE s.id=1`,
    )
    if (!row) throw new PlatformDatabaseError('unavailable', 'Platform database security state is unavailable')
    return {
      database: { kind: this.kind(), address: this.database.address(), serverVersion: row.version, state: 'connected' },
      masterKey: {
        fingerprint: row.fingerprint,
        backup: row.confirmed_at === null ? null : { username: row.username!, spaceId: row.space_id!, confirmedAt: row.confirmed_at.toISOString() },
      },
    }
  }
}
