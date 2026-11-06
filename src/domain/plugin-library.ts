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
/** Recorded when a package name first enters the library; replacements and updates must keep it. The npm package name is the row key. */
export type PluginSource = { readonly kind: 'npm' } | { readonly kind: 'upload' } | { readonly kind: 'github'; readonly repository: string }
export const npmPluginSource: PluginSource = { kind: 'npm' }
export const uploadPluginSource: PluginSource = { kind: 'upload' }
export function githubPluginSource(repository: string): PluginSource {
  assertGithubRepository(repository)
  return { kind: 'github', repository }
}
/** GitHub owner and repository names as accepted by github.com; dot-only names are reserved. */
export function assertGithubRepository(repository: string): void {
  const [owner, name, ...rest] = typeof repository === 'string' ? repository.split('/') : []
  if (
    rest.length ||
    !owner ||
    !name ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(owner) ||
    !/^[A-Za-z0-9._-]{1,100}$/u.test(name) ||
    name === '.' ||
    name === '..' ||
    name.endsWith('.git')
  )
    throw new BusinessRuleError('invalid', 'Enter a GitHub repository such as github:owner/repo.', 'plugin-input-invalid')
}
/** Strict reader for stored facts: an unknown or missing source is never assumed to be npm. */
export function decodePluginSource(value: unknown): PluginSource {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>
    const keys = Object.keys(row).sort().join(',')
    if (keys === 'kind' && row.kind === 'npm') return npmPluginSource
    if (keys === 'kind' && row.kind === 'upload') return uploadPluginSource
    if (keys === 'kind,repository' && row.kind === 'github' && typeof row.repository === 'string') {
      try {
        return githubPluginSource(row.repository)
      } catch {
        /* Rejected below. */
      }
    }
  }
  throw new Error('Invalid stored plugin source')
}
/** GitHub names are case-insensitive, so one repository cannot be recorded twice under different spellings. */
export function samePluginSource(left: PluginSource, right: PluginSource): boolean {
  if (left.kind === 'github' || right.kind === 'github')
    return left.kind === 'github' && right.kind === 'github' && left.repository.toLowerCase() === right.repository.toLowerCase()
  return left.kind === right.kind
}
export function assertPluginSource(row: LibraryPlugin | undefined, source: PluginSource): void {
  if (row && !samePluginSource(row.source, source))
    throw new BusinessRuleError(
      'conflict',
      'This plugin was added from another source. Remove it from the library before adding it again.',
      'plugin-source-conflict',
    )
}
export const PLUGIN_UPLOAD_MAX_BYTES = 50 * 1024 * 1024
/** A GitHub source archive may carry repository files outside the packed plugin. */
export const PLUGIN_SOURCE_ARCHIVE_MAX_BYTES = 200 * 1024 * 1024
export interface PreparedPlugin extends PluginIdentity {
  readonly preparationId?: string
  /** GitHub sources: the commit whose packed content has this integrity. */
  readonly sourceCommit?: string
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
  readonly source: PluginSource
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
  | 'plugin-registry-unavailable'
  | 'plugin-registry-metadata-invalid'
  | 'plugin-precheck-failed'
  | 'plugin-runtime-required'
  | 'plugin-dependency-invalid'
  | 'plugin-integrity-invalid'
  | 'plugin-job-interrupted'
  | 'plugin-package-invalid'
  | 'plugin-version-conflict'
  | 'plugin-github-unavailable'
  | 'plugin-github-repository-missing'
  | 'plugin-build-required'
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
  if (prepared.sourceCommit !== undefined && !/^[a-f0-9]{40}$/u.test(prepared.sourceCommit)) throw new PluginPreparationError('plugin-package-invalid')
}

/** A commit names the content it was packed from; re-preparing the same bytes keeps that fact. */
export function withSourceCommit(prepared: PreparedPlugin, previous: PreparedPlugin | null | undefined): PreparedPlugin {
  return previous?.sourceCommit && previous.integrity === prepared.integrity ? { ...prepared, sourceCommit: previous.sourceCommit } : prepared
}

/** A timed-out request is a source failure; only an explicit caller abort interrupts the job. */
export function pluginSourceAbortCode(signal: AbortSignal, timeoutCode: PluginPreparationFailureCode): PluginPreparationFailureCode {
  return signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? timeoutCode : 'plugin-job-interrupted'
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
    source: row.source.kind,
    ...(row.source.kind === 'github' ? { repository: row.source.repository } : {}),
    ...(row.current?.sourceCommit ? { sourceCommit: row.current.sourceCommit } : {}),
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
