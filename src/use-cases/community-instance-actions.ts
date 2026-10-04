import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import type { CommunityAccountStatePort } from '../ports/community-accounts.js'
import type { CommunityRuntimePort, CommunityUserInstance } from '../ports/community-runtime.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'

/** Authenticated member operations; neither the plugin nor request body chooses a target. */
export class CommunityInstanceActions {
  private readonly restarting = new Map<string, Promise<CommunityUserInstance>>()
  constructor(private readonly accounts: CommunityAccountStatePort,
    private readonly runtime: Pick<CommunityRuntimePort, 'restart'>,
    private readonly connections: Pick<SessionRegistryPort, 'closeUser'>) {}

  async restart(actor: CommunityAccountActor, origin: URL): Promise<CommunityUserInstance> {
    this.assertCurrent(actor)
    let operation = this.restarting.get(actor.username)
    if (operation === undefined) {
      operation = (async () => {
        await this.connections.closeUser(actor.username)
        this.assertCurrent(actor)
        return await this.runtime.restart(actor.username, origin.href)
      })()
      this.restarting.set(actor.username, operation)
      void operation.finally(() => { if (this.restarting.get(actor.username) === operation) this.restarting.delete(actor.username) }).catch(() => {})
    }
    const instance = await operation
    this.assertCurrent(actor)
    return instance
  }
  private assertCurrent(actor: CommunityAccountActor): void {
    const account = this.accounts.getState(actor.username)
    if (account === undefined || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required')
  }
}
