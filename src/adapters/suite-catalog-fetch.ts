import { suiteCatalogFetchTimeoutMs, suiteCatalogMaximumBytes } from '../domain/suite-catalog-source.js'
import type { SuiteCatalogFetchPort } from '../ports/suite-catalog.js'

/** Bounded HTTP(S) reader for the signed catalog; no caching and no fallback snapshot. */
export class HttpSuiteCatalogFetch implements SuiteCatalogFetchPort {
  constructor(private readonly timeoutMs = suiteCatalogFetchTimeoutMs, private readonly maximumBytes = suiteCatalogMaximumBytes) {}
  async fetch(address: string, signal: AbortSignal): Promise<Uint8Array> {
    let url: URL
    try { url = new URL(address) } catch { throw new Error('The suite catalog address is not a URL.') }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The suite catalog address must use HTTP(S).')
    let response: Response
    try {
      response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]), redirect: 'follow', headers: { accept: 'application/json' } })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`The catalog service did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`)
      throw new Error('The catalog service could not be reached.')
    }
    if (!response.ok) throw new Error(`The catalog service answered HTTP ${response.status}.`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > this.maximumBytes) throw new Error('The catalog is larger than the platform limit.')
    const body = response.body
    if (!body) throw new Error('The catalog response has no body.')
    const reader = body.getReader(), chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > this.maximumBytes) { await reader.cancel().catch(() => {}); throw new Error('The catalog is larger than the platform limit.') }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return bytes
  }
}
