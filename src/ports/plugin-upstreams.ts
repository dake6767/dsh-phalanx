import type { PluginUpstream } from '../domain/plugin-upstream.js'
export interface PluginUpstreamsPort {
  list(packageName: string): readonly PluginUpstream[]
  save(packageName: string, upstreams: readonly PluginUpstream[]): void
}
export interface PluginUpstreamReferencesPort {
  references(packageName: string, upstreamName: string): readonly string[]
}
export interface PluginUpstreamTransportPort {
  send(input: { readonly upstream: PluginUpstream, readonly path: string, readonly method: string,
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>, readonly body: ReadableStream<Uint8Array>, readonly signal: AbortSignal }): Promise<Response>
}
