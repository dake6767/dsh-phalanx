/** Durable suite install records; one record per catalog id. */
export type SuiteInstallStatus = 'installing' | 'installed' | 'failed' | 'uninstalling' | 'detaching' | 'updating'

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
  readonly entries: readonly SuiteInstalledEntry[]
  readonly dependencies?: readonly string[]
  readonly dependencyRows: readonly import('./runtime-dependency.js').RuntimeDependency[]
  readonly skills: readonly import('./skill-library.js').LibrarySkill[]
  readonly pack?: import('./skill-pack.js').SkillPack
  readonly executions: readonly SuiteExecutionSnapshot[]
  readonly assignments?: SuiteSkillAssignments
}

/** Dotted numeric versions compare by number; anything else compares as text. */
export function compareSuiteVersions(left: string, right: string): number {
  const parts = (value: string) => value.split('.').map(part => /^\d+$/u.test(part) ? Number(part) : NaN)
  const a = parts(left), b = parts(right)
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return left.localeCompare(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0)
  return 0
}

/** Non-secret execution state needed to undo a takeover; saved credential values never leave the execution store. */
export interface SuiteExecutionSnapshot {
  readonly owner: string
  readonly enabled: boolean
  readonly commands: readonly { readonly command: string, readonly blocked: readonly string[] }[]
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
