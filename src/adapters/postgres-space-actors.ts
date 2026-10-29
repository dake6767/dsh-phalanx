import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { SpaceAdministrators, SpaceResetActors } from '../ports/space-actors.js'
import { AdvisoryLock, transactionSharedLock } from './advisory-locks.js'
import { publicRecord, type AccountRow } from './postgres-community-account-record.js'
import { repositorySql, type RowRepositoryConnection } from './postgres-row-repository.js'

/** Account policy stays stable from these fresh parent reads through the caller's COMMIT. */
export class PostgresSpaceActors implements SpaceAdministrators, SpaceResetActors {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async lockAdministrator(actor: CommunityAccountActor, target?: Pick<CommunityAccountActor, 'username' | 'spaceId'>): Promise<void> {
    await this.protect(actor, target, 'administrator')
  }
  async lockReset(actor: CommunityAccountActor, target: Pick<CommunityAccountActor, 'username' | 'spaceId'>) {
    return await this.protect(actor, target, 'reset')
  }
  private async protect(
    actor: CommunityAccountActor,
    target: Pick<CommunityAccountActor, 'username' | 'spaceId'> | undefined,
    mode: 'administrator' | 'reset',
  ) {
    const sql = repositorySql(this.connection)
    await sql.query(transactionSharedLock(AdvisoryLock.accounts))
    const spaces = [...new Set([actor.spaceId, ...(target ? [target.spaceId] : [])])].sort()
    const rows = await sql.query<AccountRow>(
      'SELECT * FROM dsh_phalanx.accounts WHERE space_id=ANY($1::text[]) ORDER BY space_id ' + (mode === 'reset' ? 'FOR UPDATE' : 'FOR SHARE'),
      [spaces],
    )
    const current = rows.find(row => row.space_id === actor.spaceId && row.username === actor.username)
    if (!current || current.disabled || Number(current.session_epoch) !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (mode === 'administrator' && !current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
    if (mode === 'reset' && !current.admin && current.username !== target?.username)
      throw new BusinessRuleError('forbidden', 'Members may reset only their own DSH environment.', 'environment-self-only')
    const member = target ? rows.find(row => row.space_id === target.spaceId && row.username === target.username) : undefined
    if (target && !member)
      throw mode === 'reset'
        ? new BusinessRuleError('conflict', 'The target user space has changed; select the current account and retry', 'environment-space-changed')
        : new BusinessRuleError('conflict', 'Instance resource settings changed. Reload before saving or applying.', 'instance-resource-revision-conflict')
    if (mode === 'reset' && member?.disabled)
      throw new BusinessRuleError('conflict', 'Enable the account before resetting its DSH environment', 'environment-account-disabled')
    return publicRecord(current)
  }
}
