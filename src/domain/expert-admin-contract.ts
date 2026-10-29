import type { CommunityGroupRecord } from './community-group.js'
import type { ExpertInput, ExpertView, ExpertModelChoice } from './expert.js'

export interface CommunityExpertMarket {
  readonly experts: readonly {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly icon: string
    readonly examples: readonly string[]
    readonly skills: readonly string[]
    readonly skillPacks: readonly string[]
    readonly plugins: readonly string[]
    readonly mcp: readonly string[]
    readonly partial: boolean
    readonly checking?: boolean
    readonly modelLabel: string | null
    readonly status: 'granted' | 'summoned' | 'available'
  }[]
  readonly pending: boolean
}
export type CommunityExpertInput = ExpertInput
export interface CommunityExpertLibrary {
  readonly models: readonly ExpertModelChoice[]
  readonly experts: readonly ExpertView[]
  readonly revision: string
  readonly plugins: readonly { readonly packageName: string; readonly title: string; readonly eligible: boolean }[]
  readonly mcp: readonly { readonly name: string; readonly description: string }[]
}
export interface CommunityExpertImpact {
  readonly expert: { readonly id: string; readonly name: string }
  readonly members: readonly string[]
  readonly groups: readonly { readonly id: string; readonly name: string }[]
  readonly revision: string
}
export interface CommunityExpertGroup {
  readonly group: CommunityGroupRecord
  readonly experts: readonly { readonly id: string; readonly name: string; readonly description: string; readonly granted: boolean }[]
  readonly revision: string
}
