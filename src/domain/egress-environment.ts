/** Authenticated private return path for ordinary container HTTP/CONNECT traffic. */
export function egressEnvironment(proxyUrl: string): Readonly<Record<string, string>> {
  return { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1', NODE_USE_ENV_PROXY: '1' }
}
