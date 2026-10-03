import { modelUpstreamUrl, modelUpstreamHeaders } from '../dsh/model-protocol.js'
import type { CommunityModelUpstreamPort } from '../ports/community-model-upstream.js'

/** Static deployer credential is supplied only to this outgoing transport. */
export class StaticCommunityModelUpstream implements CommunityModelUpstreamPort {
  private readonly url: URL
  constructor(baseUrl: string, private readonly apiKey: string) { this.url = modelUpstreamUrl(baseUrl) }
  async sendMessages(body: string, accept: string, signal: AbortSignal): Promise<Response> {
    return await fetch(this.url, { method: 'POST', redirect: 'error', signal, body,
      headers: modelUpstreamHeaders(this.apiKey, accept) })
  }
}
