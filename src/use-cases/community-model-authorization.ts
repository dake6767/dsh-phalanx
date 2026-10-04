import { CommunityModelAccessError } from '../domain/community-model.js'
import type { CommunityAccountStatePort } from '../ports/community-accounts.js'
import type { CommunityModelAccessPort } from '../ports/community-model-access.js'

/** Current account state is authoritative even for a previously issued runtime token. */
export class CommunityModelAuthorization {
  constructor(private readonly accounts: CommunityAccountStatePort,
    private readonly access: Pick<CommunityModelAccessPort, 'resolve'>) {}
  authorize(header: string | string[] | undefined): string {
    const identity = typeof header === 'string' ? this.access.resolve(header) : undefined
    if (identity === undefined) throw new CommunityModelAccessError('unauthenticated')
    const state = this.accounts.getState(identity.username)
    if (state === undefined || state.disabled || state.spaceId !== identity.spaceId) throw new CommunityModelAccessError('forbidden')
    return state.username
  }
}
