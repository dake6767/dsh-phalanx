import { BusinessRuleError } from './business-error.js'
import type { CommunityPluginStage } from './admin-contract.js'

export interface PluginIdentity { readonly packageName: string, readonly version: string }
export interface UploadedPlugin extends PluginIdentity { readonly archive: string, readonly integrity: string }
export interface PluginCandidate extends PluginIdentity { readonly retainedIntegrity?: string; readonly upload?: { readonly archive: string, readonly integrity: string } }
export const PLUGIN_UPLOAD_MAX_BYTES = 50 * 1024 * 1024
export interface PreparedPlugin extends PluginIdentity {
  readonly preparationId?: string
  readonly integrity: string
  readonly artifact: string
  readonly runtimeRevision: string
  readonly title: string
  readonly description: string
  readonly bundlePatch: string
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly dependencies: Readonly<Record<string, string>>
}
export interface PluginReplacement extends PluginCandidate {
  readonly stage: CommunityPluginStage
  readonly prepared: PreparedPlugin | null
  readonly failureCode?: PluginPreparationFailureCode
}
export interface LibraryPlugin extends PluginCandidate {
  readonly checkedFor?: string
  readonly incompatible?: boolean
  readonly restorePublication?: boolean
  readonly removing?: boolean
  readonly identities?: Readonly<Record<string, string>>
  readonly replacement?: PluginReplacement
  readonly stage: CommunityPluginStage
  readonly current: PreparedPlugin | null
  readonly published: boolean
  readonly failureCode?: PluginPreparationFailureCode
}
export type PluginPreparationFailureCode = 'plugin-incompatible' | 'plugin-cleanup-failed' | 'plugin-precheck-failed' | 'plugin-runtime-required' | 'plugin-dependency-invalid'
  | 'plugin-integrity-invalid' | 'plugin-job-interrupted' | 'plugin-package-invalid' | 'plugin-version-conflict'
export class PluginPreparationError extends Error {
  constructor(readonly code: PluginPreparationFailureCode, options?: ErrorOptions) { super(code, options) }
}
export function assertPluginIdentity(input: PluginIdentity): void {
  const name = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
  const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u
  if (typeof input.packageName !== 'string' || input.packageName.length > 214 || !name.test(input.packageName)
    || typeof input.version !== 'string' || input.version.length > 128 || !version.test(input.version))
    throw new BusinessRuleError('invalid', 'Provide an npm package name and an exact version.', 'plugin-identity-invalid')
}

/** Portable policy also evaluated in the isolated archive/preparation worker. */
export function registryDependenciesAllowed(manifest: { readonly dependencies?: Readonly<Record<string, string>>, readonly optionalDependencies?: Readonly<Record<string, string>>, readonly peerDependencies?: Readonly<Record<string, string>> }): boolean {
  return [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies].every(declarations => Object.values(declarations ?? {}).every(value =>
    typeof value === 'string' && (!/[:/\\]/u.test(value) || /^npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@[^:/\\]+$/u.test(value))))
}

export function assertPreparedPlugin(input: PluginCandidate, prepared: PreparedPlugin, knownIntegrity?: string): void {
  if ((input.upload && prepared.integrity !== input.upload.integrity) || (input.retainedIntegrity && prepared.integrity !== input.retainedIntegrity)) throw new PluginPreparationError('plugin-integrity-invalid')
  if (knownIntegrity !== undefined && knownIntegrity !== prepared.integrity) throw new PluginPreparationError('plugin-version-conflict')
  if (!registryDependenciesAllowed(prepared)) throw new PluginPreparationError('plugin-dependency-invalid')
  if (prepared.packageName !== input.packageName || prepared.version !== input.version) throw new PluginPreparationError('plugin-package-invalid')
}
