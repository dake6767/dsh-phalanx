/** Durable suite install records; one record per catalog id. */
export type SuiteInstallStatus = 'installing' | 'installed' | 'failed' | 'uninstalling'

export interface SuiteInstalledEntry {
  readonly kind: 'runtime-dependency'
  readonly name: string
}

export interface SuiteInstallRecord {
  readonly id: string
  readonly version: string
  readonly status: SuiteInstallStatus
  readonly entries: readonly SuiteInstalledEntry[]
  readonly requestId?: string
  readonly updatedAt: number
  readonly log: string
  readonly failureCode?: string
}

export interface SuiteInstallState {
  readonly requests?: readonly string[]
  readonly installs: readonly SuiteInstallRecord[]
}

export const suiteInstallOrigin = (id: string): string => `suite:${id}`
