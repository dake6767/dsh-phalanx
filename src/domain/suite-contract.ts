/** Administrator API shapes for the suite catalog. */
import type { SuiteEntryKind } from './suite-install.js'
import type { SuiteCatalogEntryUnavailable } from './suite-catalog.js'

/** Where the last gallery load stood; the page shows unreachable and rejected reasons. */
export interface CommunitySuiteCatalogSourceView {
  readonly status: 'ok' | 'unreachable' | 'rejected'
  readonly address: string
  /** Transport diagnostic for `unreachable`; a stable rejection code for `rejected`. */
  readonly reason?: string
  readonly publishedAt?: string
}

export interface CommunitySuiteInstallEntry { readonly kind: SuiteEntryKind, readonly name: string }
export interface CommunitySuiteInstallPlanEntry { readonly kind: SuiteEntryKind, readonly name: string, readonly commands?: readonly string[], readonly detail?: string }
export interface CommunitySuiteCatalogEntryView {
  readonly id: string
  readonly category: 'suite' | 'dependency'
  readonly title: Readonly<Record<'en' | 'zh-CN', string>>
  readonly description: Readonly<Record<'en' | 'zh-CN', string>>
  readonly source: Readonly<Record<'en' | 'zh-CN', string>>
  readonly identity?: Readonly<Record<'en' | 'zh-CN', string>>
  readonly skills?: readonly string[]
  readonly packName?: string
  /** Shared catalog dependency ids this suite installs or reuses. */
  readonly dependencies?: readonly string[]
  /** External services this suite reaches at runtime. */
  readonly serviceAddresses?: readonly string[]
  /** Delegated execution template; variables carry names and purposes, never values. */
  readonly execution?: { readonly commands: readonly { readonly command: string, readonly blocked: readonly string[] }[], readonly variables: readonly { readonly name: string, readonly purpose: Readonly<Record<'en' | 'zh-CN', string>> }[] }
  readonly version: string
  readonly commands: readonly string[]
  readonly available: boolean
  /** Why a signed entry cannot be installed here: platform range, adapter, integrity or architecture. */
  readonly unavailableReason?: SuiteCatalogEntryUnavailable | 'architecture' | 'dependency-missing'
  /** Diagnostic from the catalog checks, display-only. */
  readonly unavailableDetail?: string
  readonly installedVersion?: string
  readonly updateAvailable?: boolean
}
export interface CommunitySuiteInstallView {
  readonly id: string
  readonly version: string
  readonly status: import('./suite-install.js').SuiteInstallStatus
  readonly entries: readonly CommunitySuiteInstallEntry[]
  readonly updatedAt: number
  readonly log: string
  /** Delegated execution stays off while any of these variables has no value. */
  readonly missingCredentials?: readonly string[]
  /** Shared catalog dependency ids this install uses; they keep their own install records. */
  readonly dependencies?: readonly string[]
  readonly manualDependencies?: readonly { readonly id: string, readonly name: string }[]
  readonly replaced?: readonly CommunitySuiteInstallEntry[]
}
export interface CommunitySuiteCatalogView {
  readonly entries: readonly CommunitySuiteCatalogEntryView[]
  readonly installations: readonly CommunitySuiteInstallView[]
  /** Online source state for the page banner; installation records stay usable when it fails. */
  readonly source: CommunitySuiteCatalogSourceView
}
export interface CommunitySuiteInstallPreview {
  readonly id: string
  readonly version: string
  readonly available: boolean
  readonly reason?: 'unavailable-architecture' | 'dependency-missing' | 'needs-platform-upgrade' | 'unknown-adapter' | 'invalid-adapter-params' | 'content-hash-mismatch' | 'content-tampered' | 'invalid-entry' | 'already-installed' | 'task-running' | 'skill-conflicts' | 'command-conflicts' | 'dependency-conflicts' | 'pack-conflicts'
  readonly creates: readonly CommunitySuiteInstallPlanEntry[]
  readonly conflicts?: readonly string[]
  /** Delegated commands another enabled configuration already owns. */
  readonly commandConflicts?: readonly string[]
  /** Shared catalog dependencies: installed in this task, or reused from the library without preparing again. */
  readonly dependencies?: readonly { readonly id: string, readonly action: 'install' | 'reuse' | 'manual', readonly name?: string }[]
  /** Shared catalog dependencies the current catalog does not provide right now. */
  readonly missingDependencies?: readonly string[]
  /** Manual entries the catalog version replaces once; installing requires `replace: true`. */
  readonly replacements?: readonly import('./suite-catalog.js').SuiteReplacedEntry[]
  /** Dependencies owned by the MCP catalog or another suite that provide the same commands; they block the install. */
  readonly dependencyConflicts?: readonly string[]
  /** Skill pack names already used by a manual pack; rename or remove it first. */
  readonly packConflicts?: readonly string[]
}
export interface CommunitySuiteUninstallPreview {
  readonly id: string
  readonly removes: readonly CommunitySuiteInstallEntry[]
  readonly blocked: readonly { readonly name: string, readonly references: readonly { readonly kind: string, readonly name: string }[] }[]
  readonly impact: readonly { readonly name: string, readonly groups: readonly { readonly id: string, readonly name: string }[], readonly published: boolean, readonly selectedMembers: number }[]
  /** Shared catalog dependencies: removable when nothing else references them, otherwise kept with the remaining references. */
  readonly dependencies: readonly { readonly id: string, readonly references: readonly { readonly kind: string, readonly name: string }[] }[]
}
export interface CommunitySuiteUninstallInput { readonly removeDependencies?: readonly string[] }
/** What updating an installed entry to the catalog version changes; nothing changes until the admin confirms. */
export interface CommunitySuiteUpdatePreview {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly reason?: 'not-installed' | 'task-running' | 'up-to-date' | 'unavailable-architecture' | 'skill-conflicts' | 'dependency-missing'
    | 'needs-platform-upgrade' | 'unknown-adapter' | 'invalid-adapter-params' | 'content-hash-mismatch' | 'content-tampered' | 'invalid-entry'
  /** The suite's own runtime dependency: prepared again and switched only when its definition changed. */
  readonly dependency?: { readonly name: string, readonly changed: boolean }
  readonly skills: { readonly added: readonly string[], readonly removed: readonly string[], readonly updated: readonly string[] }
  readonly pack?: { readonly name: string, readonly added: readonly string[], readonly removed: readonly string[] }
  readonly execution?: { readonly commands: { readonly added: readonly string[], readonly removed: readonly string[], readonly changed: readonly string[] }, readonly variables: { readonly added: readonly string[], readonly removed: readonly string[] } }
  /** Suites that reference this catalog dependency. */
  readonly dependents: readonly string[]
  /** Entries detached from the suite; they are not updated. */
  readonly skipped: readonly CommunitySuiteInstallEntry[]
  /** Manual dependencies the suite uses instead of a catalog dependency; they stay as they are. */
  readonly manualDependencies: readonly { readonly id: string, readonly name: string }[]
  readonly conflicts?: readonly string[]
  readonly missingDependencies?: readonly string[]
}
export interface CommunitySuiteInstallInput { readonly id: string, readonly requestId: string, readonly groups?: readonly string[], readonly publish?: boolean, readonly credentials?: Readonly<Record<string, string>>, readonly replace?: readonly import('./suite-catalog.js').SuiteReplacedEntry[] }
