import type { SuiteInstallRecord } from './suite-install.js'

/** Facts and external task progress; database transactions need no rollback snapshots. */
export type CatalogInstallRecord = SuiteInstallRecord
export interface CatalogRequestResult {
  readonly id: string
  readonly version: string
  readonly status: 'pending' | 'complete' | 'failed' | 'retired'
}
