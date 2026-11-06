import type { CommunityProviderProtocol } from '../domain/admin-contract.js'

/** The gateway base path every supported protocol shares. */
export const MODEL_GATEWAY_BASE_PATH = '/_dsh-phalanx/model'
/** The one endpoint suffix each supported protocol appends to a supplier base URL or the gateway base path. */
const protocolSuffix: Readonly<Record<CommunityProviderProtocol, string>> = {
  'anthropic-messages': '/v1/messages',
  'openai-completions': '/chat/completions',
  'openai-responses': '/responses',
}
/** The Anthropic Messages gateway path, kept as the historical default route. */
export const MODEL_GATEWAY_PATH = `${MODEL_GATEWAY_BASE_PATH}${protocolSuffix['anthropic-messages']}`
/** Every inbound gateway path, one per supported upstream protocol. */
export const MODEL_GATEWAY_PATHS: Readonly<Record<CommunityProviderProtocol, string>> = {
  'anthropic-messages': MODEL_GATEWAY_PATH,
  'openai-completions': `${MODEL_GATEWAY_BASE_PATH}${protocolSuffix['openai-completions']}`,
  'openai-responses': `${MODEL_GATEWAY_BASE_PATH}${protocolSuffix['openai-responses']}`,
}
/** The protocol whose request shape and inbound authentication a gateway path carries. */
export function modelProtocolForPath(pathname: string): CommunityProviderProtocol | undefined {
  return (Object.keys(MODEL_GATEWAY_PATHS) as CommunityProviderProtocol[]).find(protocol => MODEL_GATEWAY_PATHS[protocol] === pathname)
}

/** The retired default-model seam appends the documented DeepSeek Anthropic prefix. */
export function modelUpstreamUrl(baseUrl: string): URL {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/anthropic/v1/messages`
  return url
}

/** A supplier's base URL keeps its own prefix and gains only the protocol's endpoint path. */
export function sharedModelUpstreamUrl(baseUrl: string, protocol: CommunityProviderProtocol): URL {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}${protocolSuffix[protocol]}`
  return url
}

/** Legacy Messages headers for the retired default-model transport. */
export function modelUpstreamHeaders(apiKey: string, accept: string): Record<string, string> {
  return { accept, 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
}

/** Outgoing supplier headers follow the supplier protocol; the key never reaches a member. */
export function sharedModelUpstreamHeaders(protocol: CommunityProviderProtocol, apiKey: string, accept: string): Record<string, string> {
  return {
    accept,
    'content-type': 'application/json',
    ...(protocol === 'anthropic-messages' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${apiKey}` }),
  }
}
