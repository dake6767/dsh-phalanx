/** DeepSeek Search and Fetch API facts for the platform member gateway. */

import type { WebToolsOperation } from '../ports/community-web-tools.js'

/** Member-reachable path prefix; DSH appends nothing, so each operation has its own path. */
export const WEB_TOOLS_GATEWAY_BASE_PATH = '/_dsh-phalanx/web/v1/tools'

/** Exact member-facing paths forwarded to the DeepSeek retrieval API. */
export const WEB_TOOLS_GATEWAY_PATHS: Readonly<Record<WebToolsOperation, string>> = {
  search: `${WEB_TOOLS_GATEWAY_BASE_PATH}/search`,
  fetch: `${WEB_TOOLS_GATEWAY_BASE_PATH}/fetch`,
}

/** Public DeepSeek retrieval base; deployments own the credential, not the destination. */
export const DEEPSEEK_WEB_TOOLS_BASE_URL = 'https://api.deepseek.com/v1/tools'

/** Longest triggering question the Search API accepts. */
export const WEB_TOOLS_ORIGINAL_QUESTION_MAX_CHARS = 128

/** Build the upstream operation URL from a deployment base. */
export function webToolsUpstreamUrl(baseUrl: string, operation: WebToolsOperation): URL {
  return new URL(`${baseUrl.replace(/\/+$/u, '')}/${operation}`)
}

/** Outgoing headers; only the platform transport ever sees the provider key. */
export function webToolsUpstreamHeaders(apiKey: string): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    'user-agent': 'dsh-phalanx',
  }
}
