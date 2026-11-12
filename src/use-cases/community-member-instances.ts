import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountStatePort } from '../ports/community-accounts.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'

/** Administrator operations retain the target space and refuse overlapping requests. */
export class CommunityMemberInstances {
  private readonly pending = new Set<string>()
  constructor(
    private readonly accounts: Pick<CommunityAccountStatePort, 'getState'>,
    private readonly runtime: Pick<CommunityRuntimePort, 'operateMember' | 'refresh'>,
    private readonly connections: Pick<SessionRegistryPort, 'closeUser'>,
  ) {}

  async execute(actor: CommunityAccountActor, username: string, action: 'start' | 'restart', origin: URL, spaceId: string): Promise<void> {
    await this.assertAdmin(actor)
    if (this.pending.has(username)) throw new BusinessRuleError('conflict', 'Instance operation is already in progress', 'runtime-draining')
    this.pending.add(username)
    try {
      const target = await this.accounts.getState(username)
      if (!target || target.disabled || target.spaceId !== spaceId) throw new BusinessRuleError('invalid', 'Account is no longer active', 'account-inactive')
      const assertCurrent = async () => {
        await this.assertAdmin(actor)
        const current = await this.accounts.getState(username)
        if (!current || current.disabled || current.spaceId !== target.spaceId || current.sessionEpoch !== target.sessionEpoch)
          throw new BusinessRuleError('conflict', 'Account is no longer active', 'account-inactive')
      }
      await this.runtime.refresh?.()
      await assertCurrent()
      if (!this.runtime.operateMember) throw new BusinessRuleError('conflict', 'Instance operation is unavailable', 'runtime-startup-unavailable')
      await this.runtime.operateMember(username, action, origin.href, assertCurrent, () => this.connections.closeUser(username))
      await assertCurrent()
    } finally {
      this.pending.delete(username)
    }
  }

  private async assertAdmin(actor: CommunityAccountActor): Promise<void> {
    const current = await this.accounts.getState(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
