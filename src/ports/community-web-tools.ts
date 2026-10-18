/** DeepSeek web retrieval operation the gateway exposes to member instances. */
export type WebToolsOperation = 'search' | 'fetch'

/** Platform-side DeepSeek retrieval transport; the provider key never leaves this port. */
export interface CommunityWebToolsUpstreamPort {
  send(operation: WebToolsOperation, body: string, signal: AbortSignal): Promise<Response>
}
