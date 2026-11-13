import type { CommunityGroupView } from './admin-contract.js'

export interface CommunityManagedGroupView {
  readonly group: CommunityGroupView
  readonly revision: string
  readonly preinstallIncompleteMembers: number
  readonly plugins: readonly {
    packageName: string
    title: string
    version: string | null
    granted: boolean
    preinstalled: boolean
    hasPlatformCredential: boolean
    available: boolean
    incompatible?: boolean
    failures: readonly { username: string; code: 'plugin-managed-load-failed' }[]
    readonly checking?: readonly string[]
  }[]
  readonly pendingMembers: readonly string[]
}
export interface CatalogPluginDistributionIdentity {
  readonly packageName: string
  readonly integrity: string
  readonly entryId: string
}

export function isCatalogPluginDistributionIdentity(value: unknown): value is CatalogPluginDistributionIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== 3) return false
  const identity = value as Partial<CatalogPluginDistributionIdentity>
  return typeof identity.packageName === 'string' && typeof identity.integrity === 'string' && typeof identity.entryId === 'string'
}

export type CommunityPluginGrantAction =
  | { readonly action: 'catalog-preinstall'; readonly plugin: CatalogPluginDistributionIdentity }
  | { readonly action: 'save'; readonly packages: readonly string[]; readonly preinstalls: readonly string[]; readonly revision: string }
  | { readonly action: 'restart'; readonly confirmed: true }
