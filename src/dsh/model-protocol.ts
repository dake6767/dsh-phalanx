/** The default DeepSeek adapter's Anthropic Messages transport seam. */
export const MODEL_GATEWAY_BASE_PATH = '/_dsh-phalanx/model'
export const MODEL_GATEWAY_PATH = `${MODEL_GATEWAY_BASE_PATH}/v1/messages`
export function modelUpstreamUrl(baseUrl: string): URL {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/anthropic/v1/messages`
  return url
}

/** Messages Base URL includes any provider-specific prefix supplied by the administrator. */
export function messagesUpstreamUrl(baseUrl: string): URL {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/v1/messages`
  return url
}

/** Outgoing Messages headers shared by community and retained migration transport. */
export function modelUpstreamHeaders(apiKey: string, accept: string): Record<string, string> {
  return { accept, 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
}
