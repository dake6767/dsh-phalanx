import { suiteCatalogFetchTimeoutMs, suiteCatalogMaximumBytes } from '../domain/suite-catalog-source.js'
import type { SuiteCatalogFetchPort } from '../ports/suite-catalog.js'

const redirectStatus = new Set([301, 302, 303, 307, 308])

/**
 * Bounded HTTP(S) reader for the signed catalog; no caching and no fallback snapshot.
 * Redirects are followed manually (at most three) so every hop is checked as an HTTP(S) address. Private and
 * loopback hosts are intentionally not blocked: a deployer may point the catalog at a self-hosted mirror, and the
 * test fixtures serve it from 127.0.0.1. The signature, not the transport, is what makes the content trustworthy.
 */
export class HttpSuiteCatalogFetch implements SuiteCatalogFetchPort {
  constructor(
    private readonly timeoutMs = suiteCatalogFetchTimeoutMs,
    private readonly maximumBytes = suiteCatalogMaximumBytes,
    private readonly redirectLimit = 3,
  ) {}
  async read(address: string, signal: AbortSignal): Promise<Uint8Array> {
    let url = this.parse(address)
    for (let hop = 0; ; hop++) {
      const response = await this.request(url, signal)
      if (redirectStatus.has(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => {})
        if (!location) throw new Error('The catalog service redirected without a destination.')
        if (hop >= this.redirectLimit) throw new Error('The catalog service redirected too many times.')
        let next: URL
        try {
          next = new URL(location, url)
        } catch {
          throw new Error('The catalog service redirected to an invalid destination.')
        }
        url = this.parse(next.href)
        continue
      }
      if (!response.ok) throw new Error(`The catalog service answered HTTP ${response.status}.`)
      return this.body(response)
    }
  }
  private parse(address: string): URL {
    let url: URL
    try {
      url = new URL(address)
    } catch {
      throw new Error('The suite catalog address is not a URL.')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The suite catalog address must use HTTP(S).')
    return url
  }
  private async request(url: URL, signal: AbortSignal): Promise<Response> {
    try {
      return await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        redirect: 'manual',
        headers: { accept: 'application/json' },
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError')
        throw new Error(`The catalog service did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`)
      throw new Error('The catalog service could not be reached.')
    }
  }
  private async body(response: Response): Promise<Uint8Array> {
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > this.maximumBytes) throw new Error('The catalog is larger than the platform limit.')
    const body = response.body
    if (!body) throw new Error('The catalog response has no body.')
    const reader = body.getReader(),
      chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > this.maximumBytes) {
        await reader.cancel().catch(() => {})
        throw new Error('The catalog is larger than the platform limit.')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  }
}
