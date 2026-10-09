import { request } from 'node:http'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import { launchExchangeCookies } from '../dsh/launch-token.js'
import { DSH_RPC_PREFIX, rpcRequestBody } from '../dsh/session-protocol.js'
import { DSH_PLUGIN_LIST } from '../dsh/plugin-precheck.js'

/** One deadline covers token exchange and inventory; shutdown owns both requests. */
export async function managedPluginFailures(instance: CommunityUserInstance, origin: URL, prefixes: Readonly<Record<string, string>>, signal: AbortSignal): Promise<string[]> {
  const names = Object.keys(prefixes)
  if (!names.length) return []
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
  const deadline = setTimeout(() => controller.abort(new Error('Plugin inventory timed out')), 10000)
  try {
    const exchange = await probe(new URL(instance.launchUrl), { host: origin.host }, controller.signal)
    const cookies = launchExchangeCookies(exchange.status, exchange.cookies)
    const result = await probe(new URL(DSH_RPC_PREFIX + DSH_PLUGIN_LIST, instance.origin), {
      host: origin.host, origin: origin.origin, cookie: cookies.map(value => value.split(';')[0]).join('; '), 'content-type': 'application/json',
    }, controller.signal, rpcRequestBody('managed-plugin-status', DSH_PLUGIN_LIST, {}))
    const data = JSON.parse(result.body) as { result?: { ok?: boolean, value?: Array<{ moduleName?: string, fiberPhase?: string }> } }
    if (result.status !== 200 || !data.result?.ok || !Array.isArray(data.result.value)) throw new Error('Inventory unavailable')
    const rows = data.result.value
    return names.filter(name => { const matching = rows.filter(row => row.moduleName?.startsWith(prefixes[name]!)); return !matching.length || matching.some(row => row.fiberPhase !== 'active') })
  } catch { signal.throwIfAborted(); return names }
  finally { clearTimeout(deadline); signal.removeEventListener('abort', abort) }
}
function probe(url: URL, headers: Record<string, string>, signal: AbortSignal, body?: string) {
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
