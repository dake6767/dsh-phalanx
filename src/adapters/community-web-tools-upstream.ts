import type { PlatformSearchSettingsStore } from '../ports/platform-search-settings.js'
import type { CommunityWebToolsUpstreamPort, WebToolsOperation } from '../ports/community-web-tools.js'
import { CommunityWebToolsError } from '../domain/community-web-tools.js'
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
   * @param store - deployment-wide Search API settings.
   * @param baseUrl - retrieval base; the official host unless the caller is a test seam.
   * @param options - `testOnly` permits a non-official host for an injected fixture.
   */
  constructor(
    private readonly store: Pick<PlatformSearchSettingsStore, 'credential'>,
    baseUrl = DEEPSEEK_WEB_TOOLS_BASE_URL,
    options: { readonly testOnly?: boolean } = {},
  ) {
    if (options.testOnly !== true && !isDeploymentWebToolsBaseUrl(baseUrl)) {
      throw new Error(`DeepSeek retrieval credential can only reach ${DEEPSEEK_WEB_TOOLS_HOST}`)
    }
    this.baseUrl = baseUrl
  }
  async send(operation: WebToolsOperation, body: string, signal: AbortSignal): Promise<Response> {
    const credential = operation === 'search' ? await this.store.credential() : undefined
    if (credential === undefined) throw new CommunityWebToolsError('unconfigured', DEEPSEEK_WEB_TOOLS_HOST)
    return await fetch(webToolsUpstreamUrl(this.baseUrl, operation), {
      method: 'POST',
      redirect: 'error',
      signal,
      body,
      headers: webToolsUpstreamHeaders(credential),
    })
  }
}

/**
 * Production wiring keeps the fixed official destination. A non-official base
 * is accepted only through the explicitly named test-only composition option,
 * and only here, so no ordinary configuration path can redirect the key.
 * @param store - deployment-wide Search API settings.
 * @param testOnlyBaseUrl - injected fixture base from the test-only option.
 */
export function communityWebToolsUpstream(store: Pick<PlatformSearchSettingsStore, 'credential'>, testOnlyBaseUrl?: string): SharedCommunityWebToolsUpstream {
  return testOnlyBaseUrl === undefined
    ? new SharedCommunityWebToolsUpstream(store)
    : new SharedCommunityWebToolsUpstream(store, testOnlyBaseUrl, { testOnly: true })
}
