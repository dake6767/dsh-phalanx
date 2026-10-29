import { AdvisoryLock, transactionSharedLock } from './advisory-locks.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { ContributionActors } from '../ports/contribution-unit-of-work.js'
import { publicRecord, type AccountRow } from './postgres-community-account-record.js'
import { repositorySql, type RowRepositoryConnection } from './postgres-row-repository.js'

/** Transaction-local identity reads; no password work, independent connections or published view. */
export class PostgresContributionActors implements ContributionActors {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async lockDirectory(): Promise<void> {
    await repositorySql(this.connection).query(transactionSharedLock(AdvisoryLock.accounts))
  }
  async get(username: string) {
    const row = (await repositorySql(this.connection).query<AccountRow>('SELECT * FROM dsh_phalanx.accounts WHERE username=$1', [username]))[0]
    return row ? publicRecord(row) : undefined
  }
  async list() {
    return (await repositorySql(this.connection).query<AccountRow>('SELECT * FROM dsh_phalanx.accounts ORDER BY username')).map(publicRecord)
  }
  async listGroups() {
    const rows = await repositorySql(this.connection).query<{
      id: string
      name: string
      kind: 'ordinary' | 'admin'
      is_default: boolean
      member_count: string
    }>(`SELECT g.*,count(a.username) AS member_count FROM dsh_phalanx.groups g
      LEFT JOIN dsh_phalanx.accounts a ON a.group_id=g.id GROUP BY g.id ORDER BY g.name,g.id`)
    return rows.map(row => ({ id: row.id, name: row.name, kind: row.kind, isDefault: row.is_default, memberCount: Number(row.member_count) }))
  }
  async lock(
    actor: CommunityAccountActor,
    contributor: CommunityAccountActor,
    groups: readonly string[],
    related: readonly CommunityAccountActor[] = [],
  ): Promise<void> {
    return this.protect(actor, contributor, groups, related, true)
  }
  async lockMember(actor: CommunityAccountActor): Promise<void> {
    return this.protect(actor, actor, [], [], false)
  }
  private async protect(
    actor: CommunityAccountActor,
    contributor: CommunityAccountActor,
    groups: readonly string[],
    related: readonly CommunityAccountActor[],
    administration: boolean,
  ): Promise<void> {
    const sql = repositorySql(this.connection),
      spaces = [...new Set([actor.spaceId, contributor.spaceId, ...related.map(row => row.spaceId)])].sort()
    await this.lockDirectory()
    const before = await sql.query<AccountRow>('SELECT * FROM dsh_phalanx.accounts WHERE space_id=ANY($1::text[]) ORDER BY space_id', [spaces])
    const ids = [...new Set([...groups, ...before.map(row => row.group_id)])].sort()
    await sql.query('SELECT id FROM dsh_phalanx.groups WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [[...new Set(groups)].sort()])
    const current = await sql.query<AccountRow>(
      'SELECT * FROM dsh_phalanx.accounts WHERE space_id=ANY($1::text[]) ORDER BY space_id ' + (administration ? 'FOR SHARE' : 'FOR UPDATE'),
      [spaces],
    )
    const admin = current.find(row => row.space_id === actor.spaceId && row.username === actor.username)
    if (!admin || admin.disabled || Number(admin.session_epoch) !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (administration && !admin.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
    if (!current.some(row => row.space_id === contributor.spaceId && row.username === contributor.username) || current.some(row => !ids.includes(row.group_id)))
      throw new BusinessRuleError('conflict', 'The contributor account changed.', 'contribution-unavailable')
  }
}
