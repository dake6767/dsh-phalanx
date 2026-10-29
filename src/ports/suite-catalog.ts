/** Reads the signed catalog document from its online source; the adapter owns transport limits. */
export interface SuiteCatalogFetchPort {
  read(address: string, signal: AbortSignal): Promise<Uint8Array>
}
