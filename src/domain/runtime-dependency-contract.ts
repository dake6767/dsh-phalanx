export interface CommunityRuntimeDependencyInput {
  readonly name: string
  readonly prepareCommand: string
  readonly pathDirectories: readonly string[]
  readonly checkCommand?: string
}
export interface CommunityRuntimeDependencyView extends CommunityRuntimeDependencyInput {
  readonly source: import('./runtime-dependency.js').RuntimeDependencySource
  readonly stage: import('./runtime-dependency.js').RuntimeDependency['stage']
  readonly updatedAt: number
  readonly isolated: boolean
  readonly log: string
  readonly checks: readonly import('./runtime-dependency.js').RuntimeDependencyCheck[]
  readonly failureCode?: import('./runtime-dependency.js').RuntimeDependencyFailureCode
  readonly current?: { readonly id: string, readonly bytes: number, readonly commands: readonly string[], readonly isolated: boolean }
  readonly references: readonly import('./runtime-dependency.js').RuntimeDependencyReference[]
}

export type CommunityRuntimeDependencyAction =
  | { readonly action: 'create', readonly input: CommunityRuntimeDependencyInput }
  | { readonly action: 'prepare' | 'remove', readonly name: string }
  | { readonly action: 'update', readonly name: string, readonly input: CommunityRuntimeDependencyInput }
