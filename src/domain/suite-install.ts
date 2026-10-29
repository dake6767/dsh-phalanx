import { coerceLegacyVersion, compareSemver } from './semver.js'
import type { ExpertReferenceTarget } from './expert-reference.js'

/** Durable suite install records; one record per catalog id. */
export type SuiteInstallStatus = 'installing' | 'installed' | 'failed' | 'uninstalling' | 'updating'

export const suiteEntryKinds = ['runtime-dependency', 'skill', 'skill-pack', 'execution', 'plugin'] as const
export type SuiteEntryKind = (typeof suiteEntryKinds)[number]

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
  readonly manualDependencies?: readonly { readonly id: string; readonly name: string }[]
  /** Manual entries this install replaced once, after confirmation. */
  readonly replaced?: readonly SuiteInstalledEntry[]
  /** Entries detached from the suite; updates never bring them back. */
  readonly detached?: readonly SuiteInstalledEntry[]
}

/** Strict SemVer ordering for catalog versions; legacy short records (`1`, `1.2`) coerce to 1.0.0 / 1.2.0. */
export function compareSuiteVersions(left: string, right: string): number {
  const a = coerceLegacyVersion(left),
    b = coerceLegacyVersion(right)
  if (a && b) return compareSemver(a, b)
  return left.localeCompare(right)
}

/** Non-secret execution state needed to undo a takeover; saved credential values never leave the execution store. */
export interface SuiteExecutionSnapshot {
  readonly optionalVariables?: readonly string[]
  readonly owner: string
  readonly enabled: boolean
  readonly commands: readonly {
    readonly command: string
    readonly source?: string
    readonly memberPath?: string
    readonly blockedOptions?: readonly string[]
    readonly blocked: readonly string[]
  }[]
  readonly runtimeDependencies: readonly string[]
  readonly variables: readonly { readonly name: string; readonly secret: boolean; readonly hadValue: boolean }[]
  readonly approvedContribution?: string
  readonly contributionReceipt?: { readonly id: string; readonly revision: string; readonly warning?: string }
  readonly awaitingPreparation?: boolean
}
export interface SuiteInstallState {
  readonly requests?: readonly string[]
  readonly installs: readonly SuiteInstallRecord[]
}

export const suiteInstallOrigin = (id: string): string => `suite:${id}`
/** Delegated execution belongs to the suite skill that the catalog names. */
export const suiteExecutionOwner = (skill: string): string => `skill:${skill}`

export function suiteExpertTargets(record: SuiteInstallRecord): readonly ExpertReferenceTarget[] {
  return record.entries.flatMap<ExpertReferenceTarget>(entry =>
    entry.kind === 'skill'
      ? [{ kind: 'skill' as const, name: entry.name }]
      : entry.kind === 'skill-pack'
        ? [{ kind: 'pack' as const, name: entry.name }]
        : entry.kind === 'plugin'
          ? [{ kind: 'plugin' as const, name: entry.name }]
          : [],
  )
}

/** Assignments that removal can prune; rollback merges them into surviving groups, members and packs. */
export interface SuiteSkillAssignments {
  readonly grants: readonly { readonly id: string; readonly names: readonly string[] }[]
  readonly selections: readonly { readonly id: string; readonly names: readonly string[] }[]
  readonly packs: readonly { readonly id: string; readonly names: readonly string[] }[]
}

export function suiteOwnedReferences(record: SuiteInstallRecord): ReadonlySet<string> {
  return new Set(
    record.entries.flatMap(entry =>
      entry.kind === 'skill'
        ? [`skill:${entry.name}`]
        : entry.kind === 'execution'
          ? [`execution:${suiteExecutionOwner(entry.name)}`]
          : entry.kind === 'plugin'
            ? [`plugin:${entry.name}`]
            : [],
    ),
  )
}
