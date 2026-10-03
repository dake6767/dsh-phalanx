import type { Duplex, Readable, Writable } from 'node:stream'
import type { NetworkDestination } from './community-network.js'
export type NetworkHeaders = Readonly<Record<string, string | string[] | undefined>>
export interface NetworkHttpResponse extends Readable { readonly statusCode?: number | undefined, readonly headers: NetworkHeaders }
export interface NetworkTransport {
  connect(destination: NetworkDestination): Promise<Duplex>
  http(destination: NetworkDestination, input: { readonly method: string, readonly path: string, readonly headers: NetworkHeaders }): { readonly request: Writable, readonly response: Promise<NetworkHttpResponse> }
}
export class NetworkTransportError extends Error {
  constructor(readonly kind: 'timeout' | 'connection') { super(kind) }
}
