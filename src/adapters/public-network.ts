import { lookup } from 'node:dns/promises'
import { isIP, connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { request } from 'node:http'
import type { NetworkDestination, CommunityNetworkResolver } from '../ports/community-network.js'
import { NetworkTransportError, type NetworkTransport } from '../ports/network-transport.js'

const CONNECT_TIMEOUT = 10_000
const IDLE_TIMEOUT = 60_000
export async function resolveNetwork(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname) !== 0) return [hostname]
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }).then(addresses => addresses.map(item => item.address)),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new NetworkTransportError('timeout')) }, CONNECT_TIMEOUT) }),
    ])
  } finally { clearTimeout(timer) }
}
export function hostIPv4Addresses(): readonly string[] {
  return Object.values(networkInterfaces()).flatMap(items => items ?? []).filter(item => item.family === 'IPv4').map(item => item.address)
}
export class NodeNetworkTransport implements NetworkTransport {
  connect(grant: NetworkDestination) {
    return new Promise<import('node:net').Socket>((resolve, reject) => {
      const socket = connect({ host: grant.address, port: grant.port, family: 4 })
      const failed = () => { reject(new NetworkTransportError('connection')) }
      socket.once('error', failed)
      socket.setTimeout(CONNECT_TIMEOUT, () => { socket.destroy(); reject(new NetworkTransportError('timeout')) })
      socket.once('connect', () => {
        socket.off('error', failed); socket.on('error', () => { socket.destroy() })
        socket.setTimeout(IDLE_TIMEOUT, () => { socket.destroy() }); resolve(socket)
      })
    })
  }
  http(grant: NetworkDestination, input: Parameters<NetworkTransport['http']>[1]) {
    const outgoing = request({ hostname: grant.address, port: grant.port, family: 4, method: input.method,
      path: input.path, headers: input.headers, agent: false })
    let timer: ReturnType<typeof setTimeout> | undefined
    const response = new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      timer = setTimeout(() => { outgoing.destroy(new NetworkTransportError('timeout')) }, CONNECT_TIMEOUT)
      outgoing.once('error', error => { clearTimeout(timer); reject(error instanceof NetworkTransportError ? error : new NetworkTransportError('connection')) })
      outgoing.once('response', incoming => { clearTimeout(timer); resolve(incoming) })
    })
    outgoing.setTimeout(IDLE_TIMEOUT, () => { outgoing.destroy(new NetworkTransportError('timeout')) })
    return { request: outgoing, response }
  }
}

/** Explicit public aliases are required: interfaces cannot reveal cloud NAT mappings. */
export class NodeNetworkResolver implements CommunityNetworkResolver {
  constructor(private readonly publicOrigin?: string, private readonly hostPublicAddresses?: readonly string[]) {}
  resolve(hostname: string): Promise<readonly string[]> { return resolveNetwork(hostname) }
  async hostAddresses(): Promise<readonly string[]> {
    if (this.hostPublicAddresses === undefined || this.hostPublicAddresses.length === 0) {
      throw new Error('Deployment host address inventory is required for public networking')
    }
    return [...this.hostPublicAddresses, ...hostIPv4Addresses(), ...(this.publicOrigin === undefined ? [] : await resolveNetwork(new URL(this.publicOrigin).hostname))]
  }
}
