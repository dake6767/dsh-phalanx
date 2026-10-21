/** Outgoing default Messages request; deployer credentials belong to the adapter. */
export interface CommunityModelUpstreamPort {
  sendMessages(body: Readonly<Record<string, unknown>>, accept: string, signal: AbortSignal): Promise<Response>
}
