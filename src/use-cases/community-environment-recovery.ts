import type { Clock } from '../ports/clock.js'
import type { EnvironmentResetPersistence } from '../ports/environment-reset-persistence.js'
import type { CommunityAccountActor, CommunityAccountRecord } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityEnvironmentRecoveryError } from '../domain/community-environment.js'
import type { CommunityEnvironmentBackup, CommunityEnvironmentResetResult } from '../domain/admin-contract.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { CommunityEnvironmentPort } from '../ports/community-environment.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import type { PluginPreinstallResetPort } from '../ports/plugin-preinstalls.js'

/** Authorized repair uses the same per-space maintenance fence as restart and termination. */
export class CommunityEnvironmentRecovery {
  private readonly resetting = new Map<string, Promise<CommunityEnvironmentResetResult>>()
  constructor(
    private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>,
    private readonly runtime: Pick<CommunityRuntimePort, 'recover'>,
    private readonly environment: CommunityEnvironmentPort,
    private readonly connections: Pick<SessionRegistryPort, 'closeUser'>,
    private readonly persistence: EnvironmentResetPersistence,
    private readonly clock: Clock,
    private readonly plugins?: PluginPreinstallResetPort,
  ) {}

  async reset(actor: CommunityAccountActor, username: string, origin: URL): Promise<CommunityEnvironmentResetResult> {
    await this.assertAllowed(actor, username)
    const target = await this.target(username)
    let task = this.resetting.get(target.spaceId)
    if (task === undefined) {
      task = Promise.resolve().then(async () => {
        await this.persistence.work.run(async repositories => {
          const initiator = await repositories.actors.lockReset(actor, target)
          const previous = await repositories.history.get(target.spaceId),
            at = this.clock.now()
          if (!initiator.admin && previous?.lastMemberAcceptedAt !== undefined && at - previous.lastMemberAcceptedAt < 600_000) {
            throw new BusinessRuleError('conflict', 'Wait {seconds} seconds before resetting your environment again.', 'environment-reset-rate-limited', {
              seconds: Math.ceil((previous.lastMemberAcceptedAt + 600_000 - at) / 1000),
            })
          }
          await repositories.history.save(target.spaceId, {
            ...previous,
            ...(!initiator.admin ? { lastMemberAcceptedAt: at } : {}),
            recent: { at, username: initiator.username, role: initiator.admin ? 'admin' : 'member' },
          })
        })
        return await this.repair(actor, target, origin)
      })
      this.resetting.set(target.spaceId, task)
      void task
        .finally(() => {
          if (this.resetting.get(target.spaceId) === task) this.resetting.delete(target.spaceId)
        })
        .catch(() => {})
    }
    const result = await task
    await this.assertCurrent(actor, target)
    return result
  }
  async lastRequestedFor(account: CommunityAccountRecord) {
    return (await this.persistence.history.get(account.spaceId))?.recent
  }
  private async repair(actor: CommunityAccountActor, target: CommunityAccountRecord, origin: URL): Promise<CommunityEnvironmentResetResult> {
    let phase: 'stop' | 'backup' | 'reset' | 'start' = 'stop'
    let backup: CommunityEnvironmentBackup | undefined
    try {
      await this.assertCurrent(actor, target)
      await this.connections.closeUser(target.username)
      await this.assertCurrent(actor, target)
      await this.runtime.recover(target.username, origin.href, async () => {
        await this.assertCurrent(actor, target)
        await this.plugins?.beforeReset(target.spaceId)
        await this.assertCurrent(actor, target)
        phase = 'backup'
        backup = await this.environment.backup(target.username, target.spaceId)
        await this.assertCurrent(actor, target)
        phase = 'reset'
        await this.environment.reset(target.username, target.spaceId, backup)
        await this.assertCurrent(actor, target)
        await this.plugins?.afterReset(target.spaceId)
        phase = 'start'
      })
      await this.assertCurrent(actor, target)
      return { username: target.username, spaceId: target.spaceId, entry: `/app/${target.spaceId}/`, backup: backup! }
    } catch (cause) {
      await this.assertCurrent(actor, target)
      throw new CommunityEnvironmentRecoveryError(phase, backup, { cause })
    }
  }
  private async target(username: string): Promise<CommunityAccountRecord> {
    const account = await this.accounts.get(username)
    if (account === undefined) throw new BusinessRuleError('missing', 'Account was not found', 'account-not-found')
    if (account.disabled) throw new BusinessRuleError('conflict', 'Enable the account before resetting its DSH environment', 'environment-account-disabled')
    return account
  }
  private async assertCurrent(actor: CommunityAccountActor, target: CommunityAccountRecord) {
    await this.assertAllowed(actor, target.username)
    if ((await this.target(target.username)).spaceId !== target.spaceId)
      throw new BusinessRuleError('conflict', 'The target user space has changed; select the current account and retry', 'environment-space-changed')
  }
  private async assertAllowed(actor: CommunityAccountActor, username: string) {
    const current = await this.accounts.get(actor.username)
    if (current === undefined || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin && current.username !== username)
      throw new BusinessRuleError('forbidden', 'Members may reset only their own DSH environment.', 'environment-self-only')
    return current
  }
}
