import { communitySpacePath } from '../domain/community-space.js'
import { CommunityAuthenticationError, type CommunityAccountState } from '../domain/community-account.js'
import type { CommunityAccountOnboardingStorePort } from '../ports/community-accounts.js'
import type { CommunityUserSpaceStoragePort } from '../ports/community-user-spaces.js'
import type { DshSessionPort } from '../ports/dsh-session.js'
import { CommunityRuntimeUnavailableError, type CommunityRuntimePort, type CommunityUserInstance } from '../ports/community-runtime.js'

/** Entry selects only the authenticated account's instance and rechecks durable access after startup. */
export class CommunityEntry {
  constructor(private readonly accounts: Pick<CommunityAccountOnboardingStorePort, 'authenticate' | 'getState'>,
    private readonly runtime: CommunityRuntimePort,
    private readonly session: Pick<DshSessionPort, 'exchangeLaunchToken'>,
    private readonly storage?: Pick<CommunityUserSpaceStoragePort, 'assertAvailable'>) {}

  account(userId: string): CommunityAccountState {
    const account = this.accounts.getState(userId)
    if (account === undefined || account.disabled) throw new CommunityAuthenticationError('Account is no longer active')
    return account
  }
  spacePath(userId: string): string {
    return communitySpacePath(this.account(userId).spaceId)
  }
  accessClosed(userId: string): boolean {
    const account = this.accounts.getState(userId)
    return account === undefined || account.disabled
  }
  async ensure(userId: string, origin: URL): Promise<CommunityUserInstance> {
    this.storage?.assertAvailable()
    if (this.accessClosed(userId)) throw new CommunityRuntimeUnavailableError('authorization-unavailable', 'Account is no longer active')
    try { return await this.runtime.ensure(userId, origin.href) }
    catch (error) {
      if (error instanceof CommunityRuntimeUnavailableError) throw error
      throw new CommunityRuntimeUnavailableError('startup-unavailable', 'DSH could not start. Use the platform recovery page or ask an administrator to reset its environment.', { cause: error })
    }
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
    if (account.admin) return { account, cookies: [] as string[] }
    try { return { account, cookies: await this.openSpace(account, origin) } }
    catch (error) {
      if (!(error instanceof CommunityRuntimeUnavailableError) || error.reason === 'authorization-unavailable') throw error
      const fresh = this.accounts.getState(account.username)
      if (fresh === undefined || fresh.disabled || fresh.spaceId !== account.spaceId || fresh.sessionEpoch !== account.sessionEpoch)
        throw new CommunityRuntimeUnavailableError('authorization-unavailable', 'Account access changed during sign in; retry')
      return { account, cookies: [] as string[], recovery: true as const }
    }
  }
  async openSpace(account: CommunityAccountState, origin: URL): Promise<string[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const instance = await this.ensure(account.username, origin)
      let cookies: string[]
      try { cookies = await this.session.exchangeLaunchToken(instance, origin) }
      catch (error) {
        if (!this.current(account.username, instance)) continue
        throw new CommunityRuntimeUnavailableError('startup-unavailable', 'DSH login could not be completed. Use the platform recovery page.', { cause: error })
      }
      const fresh = this.accounts.getState(account.username)
      if (fresh === undefined || fresh.disabled || fresh.spaceId !== account.spaceId || fresh.sessionEpoch !== account.sessionEpoch) {
        throw new CommunityRuntimeUnavailableError('authorization-unavailable', 'Account access changed during sign in; retry')
      }
      if (this.current(account.username, instance)) return cookies
    }
    throw new CommunityRuntimeUnavailableError('start-cancelled', 'User instance changed during sign in; retry')
  }
}
