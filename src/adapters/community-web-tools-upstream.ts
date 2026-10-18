import type { SharedModelStorePort } from '../ports/shared-models.js'
import type { CommunityWebToolsUpstreamPort } from '../ports/community-web-tools.js'
import { CommunityWebToolsError } from '../domain/community-web-tools.js'
import { webToolsCredential } from '../domain/shared-models.js'
import type { WebToolsOperation } from '../ports/community-web-tools.js'
import { DEEPSEEK_WEB_TOOLS_BASE_URL, webToolsUpstreamHeaders, webToolsUpstreamUrl } from '../dsh/web-tools.js'

/** Forward one retrieval operation with the administrator's DeepSeek credential. */
export class SharedCommunityWebToolsUpstream implements CommunityWebToolsUpstreamPort {
  private readonly baseUrl: string
  constructor(private readonly store: Pick<SharedModelStorePort, 'read'>, baseUrl = DEEPSEEK_WEB_TOOLS_BASE_URL) {
    this.baseUrl = baseUrl
  }
  async send(operation: WebToolsOperation, body: string, signal: AbortSignal): Promise<Response> {
    const credential = webToolsCredential(this.store.read())
    if (credential === undefined) throw new CommunityWebToolsError('unconfigured')
    return await fetch(webToolsUpstreamUrl(this.baseUrl, operation), {
      method: 'POST', redirect: 'error', signal, body, headers: webToolsUpstreamHeaders(credential.apiKey),
    })
  }
}
