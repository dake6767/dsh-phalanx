/** Administrator API shapes for the suite catalog. */
import type { SuiteEntryKind } from './suite-install.js'

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
  /** Delegated execution template; variables carry names and purposes, never values. */
  readonly execution?: { readonly commands: readonly { readonly command: string, readonly blocked: readonly string[] }[], readonly variables: readonly { readonly name: string, readonly purpose: Readonly<Record<'en' | 'zh-CN', string>> }[] }
  readonly version: string
  readonly commands: readonly string[]
  readonly available: boolean
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
}
export interface CommunitySuiteCatalogView {
  readonly entries: readonly CommunitySuiteCatalogEntryView[]
  readonly installations: readonly CommunitySuiteInstallView[]
}
export interface CommunitySuiteInstallPreview {
  readonly id: string
  readonly version: string
  readonly available: boolean
  readonly reason?: 'unavailable-architecture' | 'already-installed' | 'task-running' | 'skill-conflicts' | 'command-conflicts'
  readonly creates: readonly CommunitySuiteInstallPlanEntry[]
  readonly conflicts?: readonly string[]
  /** Delegated commands another enabled configuration already owns. */
  readonly commandConflicts?: readonly string[]
  /** Shared catalog dependencies: installed in this task, or reused from the library without preparing again. */
  readonly dependencies?: readonly { readonly id: string, readonly action: 'install' | 'reuse' }[]
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
export interface CommunitySuiteInstallInput { readonly id: string, readonly requestId: string, readonly groups?: readonly string[], readonly publish?: boolean, readonly credentials?: Readonly<Record<string, string>> }
