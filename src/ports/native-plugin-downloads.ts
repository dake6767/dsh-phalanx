export interface PluginDownloadGrant {
  readonly username: string
  readonly spaceId: string
  readonly sessionEpoch: number
  readonly packageName: string
  readonly integrity: string
  readonly artifact: string
  readonly expiresAt: number
}
export interface PluginDownloadTokensPort {
  issue(grant: PluginDownloadGrant): string
  read(token: string): PluginDownloadGrant | undefined
}
export interface PluginArchiveReadPort {
  open(artifact: string): Promise<{ readonly size: number; readonly body: AsyncIterable<Uint8Array> }>
}
