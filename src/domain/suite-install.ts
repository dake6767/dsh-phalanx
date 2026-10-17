/** Durable suite install records; one record per catalog id. */
export type SuiteInstallStatus = 'installing' | 'installed' | 'failed' | 'uninstalling' | 'detaching'

export const suiteEntryKinds = ['runtime-dependency', 'skill', 'skill-pack', 'execution'] as const
export type SuiteEntryKind = typeof suiteEntryKinds[number]

export interface SuiteInstalledEntry {
  readonly kind: SuiteEntryKind
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
  /** Shared catalog dependency ids a suite installed or reused; their own records own their rows. */
  readonly dependencies?: readonly string[]
}

export interface SuiteInstallState {
  readonly requests?: readonly string[]
  readonly installs: readonly SuiteInstallRecord[]
}

export const suiteInstallOrigin = (id: string): string => `suite:${id}`
/** Delegated execution belongs to the suite skill that the catalog names. */
export const suiteExecutionOwner = (skill: string): string => `skill:${skill}`
