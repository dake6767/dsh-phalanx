import { request } from 'node:http'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import { launchExchangeCookies } from '../dsh/launch-token.js'
import { DSH_RPC_PREFIX, rpcRequestBody, rpcResponseValue } from '../dsh/session-protocol.js'

/** Official launch exchange and RPC envelope; all transport work obeys the caller's deadline. */
export async function dshPluginRpc(instance: CommunityUserInstance, origin: URL, method: string, args: object, signal: AbortSignal): Promise<unknown> {
  const exchange = await dshPluginRequest(new URL(instance.launchUrl), { host: origin.host }, signal)
  const cookies = launchExchangeCookies(exchange.status, exchange.cookies)
  const result = await dshPluginRequest(new URL(DSH_RPC_PREFIX + method, instance.origin), {
    host: origin.host, origin: origin.origin, cookie: cookies.map(value => value.split(';')[0]).join('; '), 'content-type': 'application/json',
  }, signal, rpcRequestBody('platform-plugin-operation', method, args))
  if (result.status !== 200) throw new Error('Plugin operation unavailable')
  return rpcResponseValue(result.body, method)
}
export function dshPluginRequest(url: URL, headers: Record<string, string>, signal: AbortSignal, body?: string) {
  return new Promise<{ status: number | undefined, cookies: string[] | undefined, body: string }>((resolve, reject) => {
    const req = request(url, { signal, method: body ? 'POST' : 'GET', headers }, response => {
      let size = 0; const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) response.destroy(new Error('Inventory too large')); else chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode, cookies: response.headers['set-cookie'], body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject); req.end(body)
  })
}
