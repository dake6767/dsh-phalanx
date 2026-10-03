import { CommunityAuthenticationError } from '../domain/community-account.js'
import type { CommunityAccountOnboardingStorePort } from '../ports/community-accounts.js'
import type { DshSessionPort } from '../ports/dsh-session.js'
import { CommunityRuntimeUnavailableError, type CommunityRuntimePort, type CommunityUserInstance } from '../ports/community-runtime.js'

/** Entry selects only the authenticated account's instance and rechecks durable access after startup. */
export class CommunityEntry {
  constructor(private readonly accounts: Pick<CommunityAccountOnboardingStorePort, 'authenticate' | 'getState'>,
    private readonly runtime: CommunityRuntimePort,
    private readonly session: Pick<DshSessionPort, 'exchangeLaunchToken'>) {}

  accessClosed(userId: string): boolean {
    const account = this.accounts.getState(userId)
    return account === undefined || account.disabled
  }
  async ensure(userId: string, origin: URL): Promise<CommunityUserInstance> {
    if (this.accessClosed(userId)) throw new CommunityRuntimeUnavailableError('authorization-unavailable', 'Account is no longer active')
    return await this.runtime.ensure(userId, origin.host)
  }
  current(userId: string, instance: CommunityUserInstance): boolean {
    const status = this.runtime.status(userId)
    return !this.accessClosed(userId) && status.state === 'ready'
      && status.instance.userId === userId && status.instance.processId === instance.processId
      && status.instance.origin === instance.origin
  }
  async signIn(username: string, password: string, origin: URL) {
    const account = await this.accounts.authenticate(username, password)
    if (account === undefined) throw new CommunityAuthenticationError('Invalid username or password')
    for (let attempt = 0; attempt < 3; attempt++) {
      const instance = await this.ensure(account.username, origin)
      let cookies: string[]
      try { cookies = await this.session.exchangeLaunchToken(instance, origin) }
      catch (error) { if (!this.current(account.username, instance)) continue; throw error }
      const fresh = this.accounts.getState(account.username)
      if (fresh === undefined || fresh.disabled || fresh.sessionEpoch !== account.sessionEpoch) {
        throw new CommunityRuntimeUnavailableError('authorization-unavailable', 'Account access changed during sign in; retry')
      }
      if (this.current(account.username, instance)) return { account, cookies }
    }
    throw new CommunityRuntimeUnavailableError('start-cancelled', 'User instance changed during sign in; retry')
  }
}
