/** DeepSeek Search and Fetch API facts for the platform member gateway. */

import type { WebToolsOperation } from '../ports/community-web-tools.js'

/** Member-reachable path prefix; DSH appends nothing, so each operation has its own path. */
export const WEB_TOOLS_GATEWAY_BASE_PATH = '/_dsh-phalanx/web/v1/tools'

/** Exact member-facing paths forwarded to the DeepSeek retrieval API. */
export const WEB_TOOLS_GATEWAY_PATHS: Readonly<Record<WebToolsOperation, string>> = {
  search: `${WEB_TOOLS_GATEWAY_BASE_PATH}/search`,
  fetch: `${WEB_TOOLS_GATEWAY_BASE_PATH}/fetch`,
}

/** Public DeepSeek API host; the only host allowed to receive the platform retrieval credential. */
export const DEEPSEEK_WEB_TOOLS_HOST = 'api.deepseek.com'

/** Public DeepSeek retrieval base; deployments own the credential, not the destination. */
export const DEEPSEEK_WEB_TOOLS_BASE_URL = `https://${DEEPSEEK_WEB_TOOLS_HOST}/v1/tools`

/** Administrator-facing explanation when no retrievable DeepSeek credential exists. */
export const DEEPSEEK_WEB_TOOLS_UNAVAILABLE_MESSAGE = 'DeepSeek Search and Fetch are unavailable: no shared model '
  + `credential for ${DEEPSEEK_WEB_TOOLS_HOST} is configured. Ask an administrator to configure a DeepSeek provider in `
  + 'Model management. A provider that proxies another host does not supply this retrieval credential.'

/** Longest triggering question the Search API accepts. */
export const WEB_TOOLS_ORIGINAL_QUESTION_MAX_CHARS = 128

/** Operation one member path forwards, without a second path table elsewhere. */
export function webToolsOperationForPath(pathname: string): WebToolsOperation | undefined {
  return (Object.entries(WEB_TOOLS_GATEWAY_PATHS) as [WebToolsOperation, string][])
    .find(([, path]) => path === pathname)?.[0]
}

/** Build the upstream operation URL from a deployment base. */
export function webToolsUpstreamUrl(baseUrl: string, operation: WebToolsOperation): URL {
  return new URL(`${baseUrl.replace(/\/+$/u, '')}/${operation}`)
}

/** True for the one official retrieval destination. */
export function isDeploymentWebToolsBaseUrl(baseUrl: string): boolean {
  try { return new URL(baseUrl).hostname === DEEPSEEK_WEB_TOOLS_HOST }
  catch { return false }
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
