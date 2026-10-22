import type { CommunityGroupView } from './admin-contract.js'

export interface CommunityManagedGroupView {
  readonly group: CommunityGroupView
  readonly revision: string
  readonly preinstallIncompleteMembers: number
  readonly plugins: readonly { packageName: string, title: string, version: string | null, granted: boolean, preinstalled: boolean, hasPlatformCredential: boolean, available: boolean, incompatible?: boolean,
    failures: readonly { username: string, code: 'plugin-managed-load-failed' }[], readonly checking?: readonly string[] }[]
  readonly pendingMembers: readonly string[]
}
export type CommunityPluginGrantAction = { readonly action: 'save', readonly packages: readonly string[], readonly preinstalls: readonly string[], readonly revision: string } | { readonly action: 'restart', readonly confirmed: true }
