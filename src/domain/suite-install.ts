import { BusinessRuleError } from './business-error.js'
import { coerceLegacyVersion, compareSemver } from './semver.js'

/** Durable suite install records; one record per catalog id. */
export type SuiteInstallStatus = 'installing' | 'installed' | 'failed' | 'uninstalling' | 'detaching' | 'updating'

export const suiteEntryKinds = ['runtime-dependency', 'skill', 'skill-pack', 'execution', 'plugin'] as const
export type SuiteEntryKind = typeof suiteEntryKinds[number]

export interface SuiteInstalledEntry {
  readonly kind: SuiteEntryKind
  readonly name: string
}

export interface SuiteInstallRecord {
  readonly id: string
  readonly version: string
  /** Catalog entries are suites, plugins or dependencies; stored so recovery works while the online catalog is unreachable. */
  readonly category?: 'suite' | 'plugin' | 'dependency'
  /** Package name a plugin entry plans to take over; reserves it against manual additions while the task runs. */
  readonly dependencyNames?: Readonly<Record<string, string>>
  readonly pluginPackage?: string
  readonly pluginSettling?: boolean
  readonly detaching?: readonly SuiteInstalledEntry[]
  /** Signed catalog content identity this install accepted; absent for 0.1.18 records. */
  readonly contentHash?: string
  readonly status: SuiteInstallStatus
  readonly entries: readonly SuiteInstalledEntry[]
  readonly requestId?: string
  readonly updatedAt: number
  readonly log: string
  readonly failureCode?: string
  /** Shared catalog dependency ids a suite installed or reused; their own records own their rows. */
  readonly dependencies?: readonly string[]
  /** Shared catalog dependencies satisfied by an administrator's manual dependency (version not pinned). */
  readonly manualDependencies?: readonly { readonly id: string, readonly name: string }[]
  /** Manual entries this install replaced once, after confirmation. */
  readonly replaced?: readonly SuiteInstalledEntry[]
  /** Originals of replaced rows while the task runs, so a failure or restart restores them exactly. */
  readonly replacing?: SuiteReplacementSnapshot
  /** Entries detached from the suite; updates never bring them back. */
  readonly detached?: readonly SuiteInstalledEntry[]
  /** The installed version while an update runs, so a failure or restart switches back to it. */
  readonly settling?: readonly { readonly owner: string, readonly variables: readonly string[] }[]
  readonly updating?: SuiteUpdateSnapshot
}

/** Rows of the installed version an update replaces; credential values stay in the execution store. */
export interface SuiteUpdateSnapshot {
  readonly version: string
  readonly contentHash?: string
  readonly entries: readonly SuiteInstalledEntry[]
  readonly dependencies?: readonly string[]
  readonly dependencyRows: readonly import('./runtime-dependency.js').RuntimeDependency[]
  readonly skills: readonly import('./skill-library.js').LibrarySkill[]
  readonly pack?: import('./skill-pack.js').SkillPack
  readonly executions: readonly SuiteExecutionSnapshot[]
  /** The plugin row an update switches in place; its access settings restore through the checkpoint. */
  readonly plugin?: SuitePluginSnapshot
  readonly assignments?: SuiteSkillAssignments
}

/** Strict SemVer ordering for catalog versions; legacy short records (`1`, `1.2`) coerce to 1.0.0 / 1.2.0. */
export function compareSuiteVersions(left: string, right: string): number {
  const a = coerceLegacyVersion(left), b = coerceLegacyVersion(right)
  if (a && b) return compareSemver(a, b)
  return left.localeCompare(right)
}

/** Non-secret execution state needed to undo a takeover; saved credential values never leave the execution store. */
export interface SuiteExecutionSnapshot {
  readonly optionalVariables?: readonly string[]
  readonly owner: string
  readonly enabled: boolean
  readonly commands: readonly { readonly command: string, readonly source?: string, readonly memberPath?: string, readonly blockedOptions?: readonly string[], readonly blocked: readonly string[] }[]
  readonly runtimeDependencies: readonly string[]
  readonly variables: readonly { readonly name: string, readonly secret: boolean, readonly hadValue: boolean }[]
  readonly approvedContribution?: string
  readonly contributionReceipt?: { readonly id: string, readonly revision: string, readonly warning?: string }
  readonly awaitingPreparation?: boolean
  readonly prepare?: string
}
export interface SuiteReplacementSnapshot {
  readonly dependencies: readonly import('./runtime-dependency.js').RuntimeDependency[]
  readonly skills: readonly import('./skill-library.js').LibrarySkill[]
  readonly executions: readonly SuiteExecutionSnapshot[]
  /** Plugin rows the task takes over; their access settings restore through the access-store checkpoint. */
  readonly plugins?: readonly SuitePluginSnapshot[]
}
/** A plugin row the task owns; the access store holds the checkpoint restoring its configuration. */
export interface SuitePluginSnapshot {
  readonly row: import('./plugin-library.js').LibraryPlugin
}

export interface SuiteInstallState {
  readonly requests?: readonly string[]
  readonly installs: readonly SuiteInstallRecord[]
}

export const suiteInstallOrigin = (id: string): string => `suite:${id}`
/** Delegated execution belongs to the suite skill that the catalog names. */
export const suiteExecutionOwner = (skill: string): string => `skill:${skill}`

/** Assignments that removal can prune; rollback merges them into surviving groups, members and packs. */
export interface SuiteSkillAssignments {
  readonly grants: readonly { readonly id: string, readonly names: readonly string[] }[]
  readonly selections: readonly { readonly id: string, readonly names: readonly string[] }[]
  readonly packs: readonly { readonly id: string, readonly names: readonly string[] }[]
}

/** Stable installed or failed records may be changed only after their pending recovery completes. */
export function installedSuiteRecord(state: SuiteInstallState, id: string): SuiteInstallRecord {
    const record = state.installs.find(row => row.id === id)
    if (!record || record.status !== 'installed' && record.status !== 'failed' || record.replacing || record.pluginSettling) throw new BusinessRuleError(record ? 'conflict' : 'missing',
      record ? 'A task is already running for this entry.' : 'This catalog entry is not installed.',
      record ? 'suite-task-running' : 'suite-not-installed')
    return record
}
