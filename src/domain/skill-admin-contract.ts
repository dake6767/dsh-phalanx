import type { CommunityGroupRecord } from './community-group.js'
/** Management wire types owned by this domain; exported through admin-contract. */
export interface CommunitySkillImpact {
  readonly managedMembers: number
  readonly selectedMembers: number
  readonly revision: string
}
export interface CommunitySkillView {
  readonly hasPlatformCredential?: boolean
  readonly topLevel: boolean
  readonly runtimeDependencies?: readonly string[]
  readonly provenance?: import('./library-contribution.js').LibraryProvenance
  readonly maintenanceRevision?: string
  readonly source?: import('./skill-git-source.js').SkillGitSource
  readonly suiteOrigin?: string
  readonly packs?: readonly string[]
  readonly name: string
  readonly description: string
  readonly hash: string
  readonly importedAt: number
  readonly published: boolean
  readonly conflict?: boolean
  readonly managedMembers: number
  readonly selectedMembers: number
}
export interface CommunitySkillDetail extends CommunitySkillView, CommunitySkillImpact {
  readonly experts: readonly { readonly id: string; readonly name: string }[]
  readonly markdown: string
  readonly files: readonly string[]
}
export interface CommunitySkillPreview {
  readonly token: string
  readonly name: string
  readonly description: string
  readonly markdown: string
  readonly files: readonly string[]
  readonly replacing: boolean
  readonly revision: string
  readonly managedMembers: number
  readonly selectedMembers: number
}
export type CommunitySkillChangeAction =
  | { readonly action: 'confirm'; readonly token: string; readonly revision: string }
  | { readonly action: 'remove'; readonly name: string; readonly revision: string }
  | { readonly action: 'cancel'; readonly token: string }
  | { readonly action: 'publish'; readonly name: string; readonly published: boolean; readonly revision: string }

export interface CommunitySkillGroupView {
  readonly packs?: readonly {
    readonly displayName?: string
    readonly name: string
    readonly description: string
    readonly granted: boolean
    readonly skills: readonly string[]
    readonly empty: boolean
  }[]
  readonly group: CommunityGroupRecord
  readonly skills: readonly {
    readonly name: string
    readonly description: string
    readonly granted: boolean
    readonly topLevel: boolean
    readonly conflict: boolean
  }[]
  readonly members: number
  readonly revision: string
}

export interface CommunitySkillSynchronization {
  readonly pending: boolean
}

export interface CommunityMarketSkillView {
  readonly topLevel: boolean
  readonly packs: readonly string[]
  readonly detailsAvailable: boolean
  readonly contribution?: { readonly name?: string; readonly anonymous: boolean }
  readonly selectable?: boolean
  readonly selectedDirectly?: boolean
  readonly name: string
  readonly description: string
  readonly status: 'install' | 'selected' | 'managed' | 'overridden'
  readonly source: 'managed' | 'selected' | null
}
export interface CommunityMarketSkills {
  readonly packs: readonly CommunityMarketPack[]
  readonly skills: readonly CommunityMarketSkillView[]
  readonly pending: boolean
}
export interface CommunityMarketSkillDetail extends CommunityMarketSkillView {
  readonly markdown: string
  readonly files: readonly string[]
}

export interface CommunityExecutionInput {
  readonly optionalVariables?: readonly string[]
  readonly runtimeDependencies?: readonly string[]
  readonly enabled: boolean
  readonly commands: readonly {
    readonly command: string
    readonly source?: string
    readonly memberPath?: string
    readonly blockedOptions?: readonly string[]
    readonly shortOptionsWithValue?: readonly string[]
    readonly blocked: readonly string[]
  }[]
  readonly variables: readonly { readonly name: string; readonly value?: string; readonly secret: boolean }[]
  readonly prepare?: string
}
export interface CommunityExecutionView extends Omit<CommunityExecutionInput, 'variables'> {
  readonly hasInstalledServices?: true
  readonly awaitingPreparation?: boolean
  readonly suiteOrigin?: string
  readonly unavailableCommands?: readonly string[]
  readonly preparation?: {
    readonly identity?: string
    readonly usable?: boolean
    readonly stage: 'preparing' | 'ready' | 'failed'
    readonly updatedAt: number
    readonly log: string
  }
  readonly variables: readonly {
    readonly name: string
    readonly value?: string
    readonly secret: boolean
    readonly configured: boolean
    readonly last4?: string
  }[]
}

export interface CommunityExecutionSettings {
  readonly limits: CommunityExecutionLimits
  readonly isolated: boolean
}
export interface CommunityExecutionTrial {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly truncated: boolean
}

export type CommunityExecutionLimits = import('./execution-control.js').ExecutionLimits

export interface CommunitySkillPackInput {
  readonly name: string
  readonly description: string
  readonly skills: readonly string[]
  readonly instructions: string
  /** Saving preserves publication; new packs start unpublished. Use the independent publish action. */
  readonly published: boolean
}
export interface CommunitySkillPackView extends CommunitySkillPackInput {
  readonly displayName?: string
  readonly hasPlatformCredential?: boolean
  readonly unavailable?: 'empty' | 'conflict'
  readonly suiteOrigin?: string
  readonly empty: boolean
  readonly conflict: boolean
  readonly revision: string
}
export interface CommunitySkillPackMember {
  readonly name: string
  readonly description: string
  readonly conflict?: boolean
}

export interface CommunitySkillPackCandidates {
  readonly rows: readonly CommunitySkillPackMember[]
  readonly next?: string
}

export interface CommunitySkillPackDetail extends CommunitySkillPackView {
  readonly members: readonly CommunitySkillPackMember[]
  readonly displayOverrides?: readonly ('displayName' | 'description')[]
  readonly removal: {
    readonly experts: readonly { readonly id: string; readonly name: string }[]
    readonly expertsWithSkills: readonly { readonly id: string; readonly name: string }[]
    readonly deleting: readonly string[]
    readonly retained: readonly { readonly name: string; readonly reasons: readonly ('other-pack' | 'direct-grant')[] }[]
    readonly groups: readonly { readonly id: string; readonly name: string }[]
    readonly selectedMembers: number
    readonly selectedMembersWithSkills: number
  }
}
export interface CommunityMarketPack {
  readonly displayName?: string
  readonly name: string
  readonly description: string
  readonly skills: readonly string[]
  readonly instructions: string
  readonly source: 'managed' | 'selected' | null
}

export interface CommunitySkillPackLibrary {
  readonly packs: readonly CommunitySkillPackView[]
  readonly revision: string
}

export interface CommunitySkillImportPreview {
  readonly failures: readonly import('./skill-import.js').SkillImportFailure[]
  readonly updating?: boolean
  readonly deleted?: readonly { readonly packs: readonly string[]; readonly name: string; readonly managedMembers: number; readonly selectedMembers: number }[]
  readonly token: string
  readonly defaultPackName: string
  readonly candidates: readonly (import('./skill-import.js').SkillImportCandidate & {
    readonly change?: 'changed' | 'added' | 'unchanged'
    readonly replacing: boolean
    readonly managedMembers: number
    readonly selectedMembers: number
  })[]
  readonly packs: readonly import('./skill-import.js').SkillImportSuggestion[]
}
export interface CommunitySkillImportInput {
  readonly removals?: readonly string[]
  readonly token: string
  readonly names: readonly string[]
  readonly replacements: readonly string[]
  readonly packs: readonly { readonly name: string; readonly description: string; readonly skills: readonly string[]; readonly note?: string }[]
}
