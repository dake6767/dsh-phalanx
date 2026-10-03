export interface NetworkDestination { readonly hostname: string, readonly address: string, readonly port: number }
export interface CommunityNetworkGrant extends NetworkDestination { readonly username: string, readonly token: string }
export type CommunityNetworkResult = { readonly status: 200, readonly grant: CommunityNetworkGrant }
  | { readonly status: 407 | 403 | 502 }
export interface CommunityNetworkResolver {
  resolve(hostname: string): Promise<readonly string[]>
  hostAddresses(): readonly string[] | Promise<readonly string[]>
}
