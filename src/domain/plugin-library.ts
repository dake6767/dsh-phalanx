import { createHash } from 'node:crypto'
import type { CommunityPluginStage, CommunityPluginView } from './admin-contract.js'
import { BusinessRuleError } from './business-error.js'
import { redactContributionContent } from './contribution-checks.js'

export interface PluginIdentity {
  readonly packageName: string
  readonly version: string
}
export interface UploadedPlugin extends PluginIdentity {
  readonly archive: string
  readonly integrity: string
}
export interface PluginCandidate extends PluginIdentity {
  readonly retainedIntegrity?: string
  readonly upload?: { readonly archive: string; readonly integrity: string }
}
export const PLUGIN_UPLOAD_MAX_BYTES = 50 * 1024 * 1024
export interface PreparedPlugin extends PluginIdentity {
  readonly preparationId?: string
  readonly integrity: string
  readonly artifact: string
  readonly runtimeRevision: string
  readonly title: string
  readonly description: string
  readonly bundlePatch: string
  readonly expertEligible?: boolean
  readonly services?: readonly string[]
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
  /** Opaque repository revision carried by a loaded row; absent on a new intent. */
  readonly revision?: number
  readonly runtimeDependencies?: readonly string[]
  /** Owning catalog origin while the plugin belongs to a catalog entry; read-only except through that entry. */
  readonly suiteOrigin?: string
  /** Hash of the catalog access template this platform applied last; updates compare it to detect manual edits. */
  readonly suiteAppliedAccess?: string
  readonly pendingAdministrator?: { readonly actor: import('./community-account.js').CommunityAccountActor; readonly submittedAt: number }
  readonly provenance?: import('./library-contribution.js').LibraryProvenance
  readonly contributionPublicationReceipt?: import('./contribution-receipt.js').ContributionReceipt
  readonly contributionDistributionReceipt?: import('./contribution-receipt.js').ContributionReceipt
  readonly contributionReceipt?: { readonly id: string; readonly revision: string }
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
export type PluginPreparationFailureCode =
  | 'plugin-incompatible'
  | 'plugin-cleanup-failed'
  | 'plugin-precheck-failed'
  | 'plugin-runtime-required'
  | 'plugin-dependency-invalid'
  | 'plugin-integrity-invalid'
  | 'plugin-job-interrupted'
  | 'plugin-package-invalid'
  | 'plugin-version-conflict'
export class PluginPreparationError extends Error {
  constructor(
    readonly code: PluginPreparationFailureCode,
    options?: ErrorOptions,
  ) {
    super(code, options)
  }
}
export function assertPluginIdentity(input: PluginIdentity): void {
  const name = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
  const version =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u
  if (
    typeof input.packageName !== 'string' ||
    input.packageName.length > 214 ||
    !name.test(input.packageName) ||
    typeof input.version !== 'string' ||
    input.version.length > 128 ||
    !version.test(input.version)
  )
    throw new BusinessRuleError('invalid', 'Provide an npm package name and an exact version.', 'plugin-identity-invalid')
}

/** Portable policy also evaluated in the isolated archive/preparation worker. */
export function registryDependenciesAllowed(manifest: {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}): boolean {
  return [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies].every(declarations =>
    Object.values(declarations ?? {}).every(
      value => typeof value === 'string' && (!/[:/\\]/u.test(value) || /^npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@[^:/\\]+$/u.test(value)),
    ),
  )
}

export function assertPreparedPlugin(input: PluginCandidate, prepared: PreparedPlugin, knownIntegrity?: string): void {
  if ((input.upload && prepared.integrity !== input.upload.integrity) || (input.retainedIntegrity && prepared.integrity !== input.retainedIntegrity))
    throw new PluginPreparationError('plugin-integrity-invalid')
  if (knownIntegrity !== undefined && knownIntegrity !== prepared.integrity) throw new PluginPreparationError('plugin-version-conflict')
  if (!registryDependenciesAllowed(prepared)) throw new PluginPreparationError('plugin-dependency-invalid')
  if (prepared.packageName !== input.packageName || prepared.version !== input.version) throw new PluginPreparationError('plugin-package-invalid')
}

/** Opaque confirmation revision for a manual plugin and its separately owned settings. */
export function pluginCatalogRevision(row: LibraryPlugin, accessRevision: string): string {
  return createHash('sha256')
    .update(JSON.stringify([row, accessRevision]))
    .digest('hex')
}

export function pluginIdentities(row?: LibraryPlugin): Readonly<Record<string, string>> {
  return {
    ...row?.identities,
    ...(row?.upload ? { [row.version]: row.upload.integrity } : {}),
    ...(row?.current ? { [row.current.version]: row.current.integrity } : {}),
    ...(row?.replacement?.upload ? { [row.replacement.version]: row.replacement.upload.integrity } : {}),
    ...(row?.replacement?.prepared ? { [row.replacement.version]: row.replacement.prepared.integrity } : {}),
  }
}
export function pluginLibraryView(row: LibraryPlugin): CommunityPluginView {
  return {
    ...(row.suiteOrigin ? { suiteOrigin: row.suiteOrigin } : {}),
    runtimeDependencies: row.runtimeDependencies ?? [],
    ...(row.provenance ? { provenance: row.provenance } : {}),
    maintenanceRevision: pluginMaintenanceRevision(row),
    ...(row.incompatible ? { incompatible: true } : {}),
    ...(row.restorePublication ? { publicationPaused: true } : {}),
    ...(row.removing ? { removing: true } : {}),
    ...(row.replacement
      ? {
          replacement: {
            version: row.replacement.version,
            stage: row.replacement.stage,
            ...(row.replacement.failureCode ? { failureCode: row.replacement.failureCode } : {}),
          },
        }
      : {}),
    source: row.upload ? 'upload' : 'npm',
    packageName: row.packageName,
    version: row.version,
    currentVersion: row.current?.version ?? null,
    title: row.contributionReceipt ? redactContributionContent(row.current?.title ?? row.packageName) : (row.current?.title ?? row.packageName),
    description: row.contributionReceipt ? redactContributionContent(row.current?.description ?? '') : (row.current?.description ?? ''),
    stage: row.stage,
    published: row.published,
    ...(row.current ? { integrity: row.current.integrity } : {}),
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
  }
}
export function pluginMaintenanceRevision(row: LibraryPlugin) {
  return JSON.stringify([row.current?.integrity, row.provenance?.maintainer ?? null, row.provenance?.anonymous ?? false])
}

export function assertWritablePlugin(row: LibraryPlugin | undefined, packageName: string, claims: readonly { readonly packageName: string }[]): void {
  if (row?.suiteOrigin)
    throw new BusinessRuleError(
      'forbidden',
      'Suite catalog entries are read-only. Uninstall the catalog entry or detach the plugin first.',
      'suite-entry-locked',
    )
  if (claims.some(row => row.packageName === packageName))
    throw new BusinessRuleError('conflict', 'A catalog task is preparing this plugin.', 'plugin-job-busy')
}

export function pluginReplacementProgress(current: LibraryPlugin, result: LibraryPlugin): LibraryPlugin {
  return {
    ...current,
    identities: { ...pluginIdentities(current), ...(result.current ? { [result.version]: result.current.integrity } : {}) },
    replacement: {
      packageName: result.packageName,
      version: result.version,
      stage: result.stage,
      prepared: result.current,
      ...(result.upload ? { upload: result.upload } : {}),
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    },
  }
}
