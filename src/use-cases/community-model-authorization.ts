import { CommunityModelAccessError } from '../domain/community-model.js'
import type { CommunityAccountStatePort } from '../ports/community-accounts.js'
import type { CommunityModelAccessPort } from '../ports/community-model-access.js'

/** Current account state is authoritative even for a previously issued runtime token. */
export class CommunityModelAuthorization {
  constructor(private readonly accounts: CommunityAccountStatePort,
    private readonly access: Pick<CommunityModelAccessPort, 'resolve'>) {}
  authorize(header: string | string[] | undefined): string {
    const username = typeof header === 'string' ? this.access.resolve(header) : undefined
    if (username === undefined) throw new CommunityModelAccessError('unauthenticated')
    const state = this.accounts.getState(username)
    if (state === undefined || state.disabled) throw new CommunityModelAccessError('forbidden')
    return state.username
  }
}
