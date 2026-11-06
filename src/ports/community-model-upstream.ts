import type { CommunityProviderProtocol } from '../domain/admin-contract.js'

/** Outgoing default model request; deployer credentials belong to the adapter. */
export interface CommunityModelUpstreamPort {
  send(body: Readonly<Record<string, unknown>>, accept: string, protocol: CommunityProviderProtocol, signal: AbortSignal): Promise<Response>
}
