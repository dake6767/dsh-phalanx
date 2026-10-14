import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import type { PluginUpstream } from '../domain/plugin-upstream.js'
export interface PluginUpstreamsPort {
  revision?(packageName: string): string
  list(packageName: string): readonly PluginUpstream[]
  receipt?(packageName: string): ContributionReceipt | undefined
  save(packageName: string, upstreams: readonly PluginUpstream[], contribution?: ContributionReceipt): void
}
export interface PluginUpstreamReferencesPort {
  references(packageName: string, upstreamName: string): readonly string[]
}
export interface PluginUpstreamTransportPort {
  send(input: { readonly headerMode?: 'literal' | 'credential-template', readonly upstream: PluginUpstream, readonly path: string | null, readonly method: string,
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>, readonly body: ReadableStream<Uint8Array>, readonly signal: AbortSignal }): Promise<Response>
}
