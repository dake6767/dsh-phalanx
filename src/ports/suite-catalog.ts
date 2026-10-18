import type { SuiteInstallState } from '../domain/suite-install.js'

export interface SuiteInstallStorePort {
  read(): SuiteInstallState
  write(state: SuiteInstallState): void
}

/** Reads the signed catalog document from its online source; the adapter owns transport limits. */
export interface SuiteCatalogFetchPort {
  fetch(address: string, signal: AbortSignal): Promise<Uint8Array>
}
