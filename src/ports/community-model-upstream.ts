/** Outgoing default Messages request; deployer credentials belong to the adapter. */
export interface CommunityModelUpstreamPort {
  sendMessages(body: string, accept: string, signal: AbortSignal): Promise<Response>
}
