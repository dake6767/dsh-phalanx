import { isPublicIPv4 } from '../domain/public-address.js'
import { CommunityModelAccessError } from '../domain/community-model.js'
import type { CommunityNetworkGrant, CommunityNetworkResolver, CommunityNetworkResult } from '../ports/community-network.js'
import type { CommunityModelAuthorization } from './community-model-authorization.js'

/** Public TCP access with pinned DNS; no policy, vault or record system. */
export class CommunityNetworkAccess {
  constructor(private readonly authorization: Pick<CommunityModelAuthorization, 'authorize'>,
    private readonly resolver: CommunityNetworkResolver) {}
  async authorize(target: { readonly hostname: string, readonly port: number }, token: string | undefined): Promise<CommunityNetworkResult> {
    const first = this.identity(token)
    if (first.status !== 200) return first
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || target.hostname === '') return { status: 403 }
    let addresses: readonly string[]
    try { addresses = await this.resolver.resolve(target.hostname) } catch { return { status: 502 } }
    const current = this.identity(token)
    if (current.status !== 200) return current
    let local: readonly string[]
    try { local = await this.resolver.hostAddresses() } catch { return { status: 502 } }
    const final = this.identity(token)
    if (final.status !== 200) return final
    const ipv4 = addresses.filter(address => !address.includes(':'))
    if (ipv4.length === 0 || ipv4.some(address => !isPublicIPv4(address) || local.includes(address))) return { status: 403 }
    return { status: 200, grant: { ...target, address: ipv4[0]!, username: current.username, token: token! } }
  }
  current(grant: CommunityNetworkGrant): boolean {
    const current = this.identity(grant.token)
    return current.status === 200 && current.username === grant.username
  }
  private identity(token: string | undefined): { readonly status: 200, readonly username: string } | { readonly status: 407 | 403 } {
    try { return { status: 200, username: this.authorization.authorize(token) } }
    catch (error) {
      if (!(error instanceof CommunityModelAccessError)) throw error
      return { status: error.kind === 'unauthenticated' ? 407 : 403 }
    }
  }
}
