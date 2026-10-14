import type { PluginUpstream } from '../domain/plugin-upstream.js'
export interface PluginUpstreamsPort {
  list(packageName: string): readonly PluginUpstream[]
  receipt?(packageName: string): { readonly id: string, readonly revision: string } | undefined
  save(packageName: string, upstreams: readonly PluginUpstream[], contribution?: { readonly id: string, readonly revision: string }): void
}
export interface PluginUpstreamReferencesPort {
  references(packageName: string, upstreamName: string): readonly string[]
}
export interface PluginUpstreamTransportPort {
  send(input: { readonly headerMode?: 'literal' | 'credential-template', readonly upstream: PluginUpstream, readonly path: string | null, readonly method: string,
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>, readonly body: ReadableStream<Uint8Array>, readonly signal: AbortSignal }): Promise<Response>
}
