import { BusinessRuleError } from './business-error.js'
import type { CommunityRuntimeDependencyInput } from './admin-contract.js'

export type RuntimeDependencySource = 'manual' | 'mcp-catalog' | 'suite-catalog' | 'migration-0.1.10'
export type RuntimeDependencyFailureCode = 'prepare-failed' | 'path-invalid' | 'link-escape' | 'command-conflict' | 'check-failed' | 'interrupted'
export interface RuntimeDependencyCheck { readonly kind: 'paths' | 'links' | 'commands' | 'check-command', readonly passed: boolean, readonly detail?: string }
export interface RuntimeDependencyReference { readonly kind: 'skill' | 'execution' | 'mcp' | 'plugin', readonly name: string }
export interface RuntimeDependencyVersion {
  readonly id: string
  readonly identity: string
  readonly directory: string
  readonly mountedPath: string
  readonly pathDirectories: readonly string[]
  readonly commands: readonly string[]
  readonly commandPaths: Readonly<Record<string, string>>
  readonly bytes: number
  readonly isolated: boolean
  readonly checks: readonly RuntimeDependencyCheck[]
  readonly log: string
}
export interface RuntimeDependencyDefinition extends CommunityRuntimeDependencyInput { readonly sourceVersion?: string }
export interface RuntimeDependency extends RuntimeDependencyDefinition {
  readonly managedOrigin?: string
  readonly replaces?: string
  readonly candidate?: boolean
  readonly migrationOrigin?: string
  readonly source: RuntimeDependencySource
  readonly stage: 'preparing' | 'validating' | 'ready' | 'failed'
  readonly retryPending?: boolean
  readonly preparationIdentity?: string
  readonly updatedAt: number
  readonly log: string
  readonly checks: readonly RuntimeDependencyCheck[]
  readonly failureCode?: RuntimeDependencyFailureCode
  readonly current?: RuntimeDependencyVersion
  readonly previous?: RuntimeDependencyVersion
}
export class RuntimeDependencyPreparationFailure extends Error {
  constructor(readonly code: RuntimeDependencyFailureCode, readonly log: string, readonly checks: readonly RuntimeDependencyCheck[] = []) { super('Runtime dependency preparation failed') }
}

/** Runtime dependencies have no credential or environment-variable declaration. */
export function runtimeDependencyInput(value: CommunityRuntimeDependencyInput): CommunityRuntimeDependencyInput {
  const fail = () => { throw new BusinessRuleError('invalid', 'Check the runtime dependency definition. Environment and credential variables are not accepted.', 'runtime-dependency-invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  if (Object.keys(value).some(key => !['name', 'prepareCommand', 'pathDirectories', 'checkCommand'].includes(key))) return fail()
  if (typeof value.name !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,99}$/u.test(value.name)
    || typeof value.prepareCommand !== 'string' || !value.prepareCommand.trim() || value.prepareCommand.length > 128 * 1024
    || !Array.isArray(value.pathDirectories) || value.pathDirectories.length === 0
    || value.pathDirectories.some(path => typeof path !== 'string' || !path || path.startsWith('/') || (/[\\:]/u.test(path) || [...path].some(character => character.charCodeAt(0) < 32)) || path.split('/').some(part => part === '..' || part === ''))
    || new Set(value.pathDirectories).size !== value.pathDirectories.length
    || (value.checkCommand !== undefined && (typeof value.checkCommand !== 'string' || value.checkCommand.length > 128 * 1024))) return fail()
  return { name: value.name, prepareCommand: value.prepareCommand, pathDirectories: [...value.pathDirectories], ...(value.checkCommand ? { checkCommand: value.checkCommand } : {}) }
}
