import type { CatalogInstallRecord, CatalogRequestResult } from '../domain/catalog-install.js'

export interface CatalogInstallRow {
  readonly record: CatalogInstallRecord
  readonly revision: string
}
export interface CatalogInstallRows {
  get(id: string): Promise<CatalogInstallRow | undefined>
  list(): Promise<readonly CatalogInstallRow[]>
  lock(id: string, expectedRevision: string): Promise<CatalogInstallRecord>
  save(record: CatalogInstallRecord, expectedRevision?: string): Promise<void>
  remove(id: string, expectedRevision: string): Promise<void>
}
export interface CatalogRequestRow {
  readonly requestId: string
  readonly result: CatalogRequestResult
  readonly revision: string
}
export interface CatalogRequestRows {
  /** Acquire before any catalog fact locks when several roles share the transaction. */
  lockLedger(): Promise<void>
  get(requestId: string): Promise<CatalogRequestRow | undefined>
  save(requestId: string, result: CatalogRequestResult, expectedRevision?: string): Promise<void>
}
