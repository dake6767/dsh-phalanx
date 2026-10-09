import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityPluginUpstreamTestResult } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { Clock } from '../ports/clock.js'
import type { PluginUpstreamsPort, PluginUpstreamTransportPort } from '../ports/plugin-upstreams.js'
import type { PluginUpstreamAdministration } from './plugin-upstream-administration.js'

/** A bounded, redacted diagnostic through the same outgoing transport as member calls. */
export class PluginUpstreamTest {
  constructor(private readonly administration: Pick<PluginUpstreamAdministration, 'list'>,
    private readonly store: Pick<PluginUpstreamsPort, 'list'>,
    private readonly transport: PluginUpstreamTransportPort, private readonly clock: Clock) {}
  async execute(actor: CommunityAccountActor, packageName: string, name: string): Promise<CommunityPluginUpstreamTestResult> {
    this.administration.list(actor, packageName)
    const upstream = this.store.list(packageName).find(row => row.name === name)
    if (!upstream?.testRequest || !upstream.credential) throw new BusinessRuleError('invalid', 'Save a test request and credential first', 'plugin-upstream-test-required')
    const started = this.clock.now(), controller = new AbortController()
    const request = upstream.testRequest
    try {
      const response = await this.transport.send({ upstream, method: request.method, path: request.path,
        headers: request.body === undefined ? {} : { 'content-type': 'application/json' },
        body: new Blob(request.body === undefined ? [] : [JSON.stringify(request.body)]).stream(), signal: controller.signal })
      const limit = 4096
      // Read ahead to mask a whole credential even when it crosses the visible boundary.
      const patterns = [...new Set([upstream.credential, JSON.stringify(upstream.credential).slice(1, -1), JSON.stringify(upstream.credential).slice(1, -1).replaceAll('/', '\\/')])]
      const bytes = new Uint8Array(limit + Math.max(...patterns.map(value => value.length)) + 1)
      let count = 0, exhausted = response.body === null
      const reader = response.body?.getReader()
      try {
        while (reader && count < bytes.length) {
          const chunk = await reader.read()
          if (chunk.done) { exhausted = true; break }
          const take = Math.min(chunk.value.length, bytes.length - count)
          bytes.set(chunk.value.subarray(0, take), count); count += take
        }
      } finally { await reader?.cancel() }
      const raw = new TextDecoder().decode(bytes.subarray(0, count))
      const visible = new TextDecoder().decode(bytes.subarray(0, Math.min(count, limit)), { stream: true }).length
      // Never display the read-ahead suffix: earlier replacements may shrink the output.
      let cursor = 0, text = ''
      while (cursor < visible) {
        const match = patterns.map(pattern => ({ index: raw.indexOf(pattern, cursor), length: pattern.length }))
          .filter(hit => hit.index >= cursor && hit.index < visible).sort((a, b) => a.index - b.index || b.length - a.length)[0]
        if (!match) { text += raw.slice(cursor, visible); break }
        text += raw.slice(cursor, match.index) + '●●●●'; cursor = match.index + match.length
      }
      const encoded = new TextEncoder().encode(text)
      const body = new TextDecoder().decode(encoded.subarray(0, limit), { stream: true })
      return { status: response.status, passed: response.ok, elapsedMs: Math.max(0, this.clock.now() - started), body, truncated: !exhausted || count > limit || encoded.length > limit }
    } catch { throw new BusinessRuleError('invalid', 'Upstream test could not complete', 'plugin-upstream-test-failed') }
    finally { controller.abort() }
  }
}
