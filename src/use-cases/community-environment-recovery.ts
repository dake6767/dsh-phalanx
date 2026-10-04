import type { CommunityAccountActor, CommunityAccountRecord } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityEnvironmentRecoveryError } from '../domain/community-environment.js'
import type { CommunityEnvironmentBackup, CommunityEnvironmentResetResult } from '../domain/admin-contract.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { CommunityEnvironmentPort } from '../ports/community-environment.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'

/** Admin repair uses the same per-space maintenance fence as restart and termination. */
export class CommunityEnvironmentRecovery {
  private readonly resetting = new Map<string, Promise<CommunityEnvironmentResetResult>>()
  constructor(private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>,
    private readonly runtime: Pick<CommunityRuntimePort, 'recover'>,
    private readonly environment: CommunityEnvironmentPort,
    private readonly connections: Pick<SessionRegistryPort, 'closeUser'>) {}

  async reset(actor: CommunityAccountActor, username: string, origin: URL): Promise<CommunityEnvironmentResetResult> {
    this.assertAdmin(actor)
    const target = this.target(username)
    let task = this.resetting.get(target.spaceId)
    if (task === undefined) {
      task = this.repair(actor, target, origin)
      this.resetting.set(target.spaceId, task)
      void task.finally(() => { if (this.resetting.get(target.spaceId) === task) this.resetting.delete(target.spaceId) }).catch(() => {})
    }
    const result = await task
    this.assertCurrent(actor, target)
    return result
  }
  private async repair(actor: CommunityAccountActor, target: CommunityAccountRecord, origin: URL): Promise<CommunityEnvironmentResetResult> {
    let phase: 'stop' | 'backup' | 'reset' | 'start' = 'stop'
    let backup: CommunityEnvironmentBackup | undefined
    try {
      await this.connections.closeUser(target.username)
      this.assertCurrent(actor, target)
      await this.runtime.recover(target.username, origin.href, async () => {
        this.assertCurrent(actor, target)
        phase = 'backup'; backup = await this.environment.backup(target.username, target.spaceId)
        this.assertCurrent(actor, target)
        phase = 'reset'; await this.environment.reset(target.username, target.spaceId, backup)
        this.assertCurrent(actor, target); phase = 'start'
      })
      this.assertCurrent(actor, target)
      return { username: target.username, spaceId: target.spaceId, entry: `/app/${target.spaceId}/`, backup: backup! }
    } catch (cause) {
      this.assertCurrent(actor, target)
      throw new CommunityEnvironmentRecoveryError(phase, backup, { cause })
    }
  }
  private target(username: string): CommunityAccountRecord {
    const account = this.accounts.get(username)
    if (account === undefined) throw new BusinessRuleError('missing', 'Account was not found')
    if (account.disabled) throw new BusinessRuleError('conflict', 'Enable the account before resetting its DSH environment')
    return account
  }
  private assertCurrent(actor: CommunityAccountActor, target: CommunityAccountRecord) {
    this.assertAdmin(actor)
    if (this.target(target.username).spaceId !== target.spaceId) throw new BusinessRuleError('conflict', 'The target user space has changed; select the current account and retry')
  }
  private assertAdmin(actor: CommunityAccountActor) {
    const current = this.accounts.get(actor.username)
    if (current === undefined || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required')
  }
}
