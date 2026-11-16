import { createProxyServer } from 'http-proxy-3'
import { Agent } from 'node:http'
import { closeIncompleteProxyResponse, handleProxyError } from './proxy-error.js'

export function createRuntimeProxy() {
  // Node caps this nonzero timeout using the upstream Keep-Alive hint and its safety buffer.
  const agent = new Agent({ keepAlive: true, timeout: 5_000 })
  const proxy = createProxyServer({ ws: true, agent })
  proxy.on('error', handleProxyError)
  proxy.on('proxyRes', closeIncompleteProxyResponse)
  return { agent, proxy }
}
