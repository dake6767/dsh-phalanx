import type { SharedModelStorePort } from '../ports/shared-models.js'
import type { CommunityWebToolsUpstreamPort, WebToolsOperation } from '../ports/community-web-tools.js'
import { CommunityWebToolsError } from '../domain/community-web-tools.js'
import { webToolsCredential } from '../domain/shared-models.js'
import {
  DEEPSEEK_WEB_TOOLS_BASE_URL,
  DEEPSEEK_WEB_TOOLS_HOST,
  isDeploymentWebToolsBaseUrl,
  webToolsUpstreamHeaders,
  webToolsUpstreamUrl,
} from '../dsh/web-tools.js'

/** Forward one retrieval operation with the administrator's DeepSeek credential. */
export class SharedCommunityWebToolsUpstream implements CommunityWebToolsUpstreamPort {
  private readonly baseUrl: string
  /**
   * @param store - published shared model configuration.
   * @param baseUrl - retrieval base; the official host unless the caller is a test seam.
   * @param options - `testOnly` permits a non-official host for an injected fixture.
   */
  constructor(
    private readonly store: Pick<SharedModelStorePort, 'read'>,
    baseUrl = DEEPSEEK_WEB_TOOLS_BASE_URL,
    options: { readonly testOnly?: boolean } = {},
  ) {
    if (options.testOnly !== true && !isDeploymentWebToolsBaseUrl(baseUrl)) {
      throw new Error(`DeepSeek retrieval credential can only reach ${DEEPSEEK_WEB_TOOLS_HOST}`)
    }
    this.baseUrl = baseUrl
  }
  async send(operation: WebToolsOperation, body: string, signal: AbortSignal): Promise<Response> {
    const credential = webToolsCredential(this.store.read(), DEEPSEEK_WEB_TOOLS_HOST)
    if (credential === undefined) throw new CommunityWebToolsError('unconfigured', DEEPSEEK_WEB_TOOLS_HOST)
    return await fetch(webToolsUpstreamUrl(this.baseUrl, operation), {
      method: 'POST',
      redirect: 'error',
      signal,
      body,
      headers: webToolsUpstreamHeaders(credential.apiKey),
    })
  }
}

/**
 * Production wiring keeps the fixed official destination. A non-official base
 * is accepted only through the explicitly named test-only composition option,
 * and only here, so no ordinary configuration path can redirect the key.
 * @param store - published shared model configuration.
 * @param testOnlyBaseUrl - injected fixture base from the test-only option.
 */
export function communityWebToolsUpstream(store: Pick<SharedModelStorePort, 'read'>, testOnlyBaseUrl?: string): SharedCommunityWebToolsUpstream {
  return testOnlyBaseUrl === undefined
    ? new SharedCommunityWebToolsUpstream(store)
    : new SharedCommunityWebToolsUpstream(store, testOnlyBaseUrl, { testOnly: true })
}
