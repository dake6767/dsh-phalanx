import type { RuntimeDependencyDefinition } from './runtime-dependency.js'
import { BusinessRuleError } from './business-error.js'
import { runtimeDependencyInput } from './runtime-dependency.js'

/** Preparation commands are keyed by deployment architecture; a missing key means unavailable. */
export type SuiteCatalogArchitecture = 'amd64' | 'arm64'
export type SuiteCatalogItemKind = 'runtime-dependency' | 'skill' | 'skill-pack' | 'execution' | 'plugin'

/** One installable unit. Every kind implements the same plan/prepare/commit/rollback/uninstall operations. */
export interface SuiteCatalogRuntimeDependencyItem {
  readonly kind: 'runtime-dependency'
  readonly type?: 'python-library' | 'resource'
  readonly packages?: readonly string[]
  readonly name: string
  readonly prepareCommands: Readonly<Partial<Record<SuiteCatalogArchitecture, string>>>
  readonly pathDirectories: readonly string[]
  readonly checkCommand?: string
  readonly commands: readonly string[]
}
export interface SuiteCatalogSkillSource {
  readonly type: 'git'
  readonly url: string
  readonly commit: string
  readonly path: string
}
export interface SuiteCatalogSkillItem {
  readonly kind: 'skill'
  readonly source: SuiteCatalogSkillSource
  readonly names: readonly string[]
  /** Suite runtime-dependency item that puts these skills' commands on the member PATH; omitted when only delegated execution provides them. */
  readonly runtimeDependency?: string
  /** Shared catalog dependency ids (from the suite's `dependencies`) these skills also need on PATH. */
  readonly catalogDependencies?: readonly string[]
}
export interface SuiteCatalogSkillPackItem {
  readonly kind: 'skill-pack'
  readonly name: string
  readonly description: string
  readonly note: string
  readonly skills: readonly string[]
}
/** Delegated execution template: names and purposes only; administrators supply variable values. */
export interface SuiteCatalogExecutionItem {
  readonly kind: 'execution'
  /** Suite skill that owns the configuration. */
  readonly skill: string
  readonly runtimeDependency: string
  readonly delegated: readonly { readonly command: string, readonly source?: string, readonly memberPath?: string, readonly blockedOptions?: readonly string[], readonly blocked: readonly string[] }[]
  readonly variables: readonly { readonly name: string, readonly optional?: boolean, readonly purpose: Readonly<Record<'en' | 'zh-CN', string>> }[]
}
export interface SuiteCatalogPluginItem {
  readonly kind: 'plugin'
  readonly packageName: string
  readonly version: string
  readonly integrity: string
  readonly runtimeDependencies: readonly string[]
  readonly catalogDependencies: readonly string[]
  readonly access: import('./admin-contract.js').CommunityPluginAccessInput
}
export type SuiteCatalogItem = SuiteCatalogPluginItem | SuiteCatalogRuntimeDependencyItem | SuiteCatalogSkillItem | SuiteCatalogSkillPackItem | SuiteCatalogExecutionItem

/** Why a signed catalog entry cannot be installed on this platform or deployment. */
export type SuiteCatalogEntryUnavailable = 'needs-platform-upgrade' | 'unknown-adapter' | 'invalid-adapter-params' | 'content-hash-mismatch' | 'content-tampered' | 'invalid-entry'
interface SuiteCatalogEntryCommon {
  /** Immutable content identity of an online entry. */
  readonly contentHash?: string
  /** Signed entries this platform refuses keep their card but cannot be installed. */
  readonly unavailableReason?: SuiteCatalogEntryUnavailable
  /** Diagnostic from the catalog checks; display-only. */
  readonly unavailableDetail?: string
}
export interface SuiteCatalogDependencyEntry extends SuiteCatalogEntryCommon {
  readonly category: 'dependency'
  readonly id: string
  readonly version: string
  readonly title: Readonly<Record<'en' | 'zh-CN', string>>
  readonly description: Readonly<Record<'en' | 'zh-CN', string>>
  readonly source: Readonly<Record<'en' | 'zh-CN', string>>
  readonly items: readonly SuiteCatalogItem[]
}
export interface SuiteCatalogSuiteEntry extends SuiteCatalogEntryCommon {
  readonly category: 'suite' | 'plugin'
  readonly id: string
  readonly version: string
  readonly title: Readonly<Record<'en' | 'zh-CN', string>>
  readonly description: Readonly<Record<'en' | 'zh-CN', string>>
  readonly source: Readonly<Record<'en' | 'zh-CN', string>>
  readonly identity: Readonly<Record<'en' | 'zh-CN', string>>
  readonly dependencies: readonly string[]
  /** Runtime service addresses the administrator can audit for egress requirements. */
  readonly serviceAddresses?: readonly string[]
  readonly items: readonly SuiteCatalogItem[]
}
export type SuiteCatalogEntry = SuiteCatalogDependencyEntry | SuiteCatalogSuiteEntry

/** A manual entry an install takes over in place. */
export interface SuiteReplacedEntry { readonly kind: 'runtime-dependency' | 'skill' | 'plugin', readonly name: string, readonly revision?: string }
export interface SuiteInstallRequest {
  readonly id: string
  readonly requestId: string
  readonly groups?: readonly string[]
  readonly publish?: boolean
  /** Delegated execution variable values; held in memory for the task only, never in the install record. */
  readonly credentials?: Readonly<Record<string, string>>
  /** The manual entries the confirmed preview listed for replacement; the install is refused if the plan differs. */
  readonly replace?: readonly SuiteReplacedEntry[]
}

export const invalidRequest = () => new BusinessRuleError('invalid', 'Invalid suite catalog request.', 'suite-catalog-invalid')

/** Blank values are skipped so a wizard may leave credentials for later. */
export function suiteCredentialsInput(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) throw invalidRequest()
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.some(([name, secret]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || typeof secret !== 'string' || secret.length > 65536 || secret.includes('\0'))) throw invalidRequest()
  return Object.fromEntries((entries as [string, string][]).filter(([, secret]) => secret.trim() !== ''))
}

export interface SuiteUninstallRequest {
  /** Shared catalog dependencies to remove with the suite; only unreferenced ones are accepted. */
  readonly removeDependencies?: readonly string[]
}

export function suiteUninstallInput(value: unknown): SuiteUninstallRequest {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'removeDependencies')) throw invalidRequest()
  const remove = (value as { removeDependencies?: unknown }).removeDependencies
  if (remove !== undefined && (!Array.isArray(remove) || remove.length > 64 || remove.some(id => typeof id !== 'string'))) throw invalidRequest()
  return remove === undefined ? {} : { removeDependencies: [...new Set(remove as string[])] }
}

export function suiteInstallInput(value: unknown): SuiteInstallRequest {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['id', 'requestId', 'groups', 'publish', 'credentials', 'replace'].includes(key))
    || typeof (value as { id?: unknown }).id !== 'string' || typeof (value as { requestId?: unknown }).requestId !== 'string'
    || !/^[A-Za-z0-9_-]{16,128}$/u.test((value as { requestId: string }).requestId)) throw invalidRequest()
  const request = value as { id: string, requestId: string, groups?: unknown, publish?: unknown, credentials?: unknown, replace?: unknown }
  if (request.replace !== undefined && (!Array.isArray(request.replace) || request.replace.length > 256 || request.replace.some(row => !row || typeof row !== 'object' || Array.isArray(row)
    || Object.keys(row).some(key => key !== 'kind' && key !== 'name' && key !== 'revision') || (row.kind !== 'runtime-dependency' && row.kind !== 'skill' && row.kind !== 'plugin') || typeof row.name !== 'string' || row.revision !== undefined && typeof row.revision !== 'string'))) throw invalidRequest()
  if (request.groups !== undefined && (!Array.isArray(request.groups) || request.groups.length > 64 || request.groups.some(group => typeof group !== 'string'))
    || request.publish !== undefined && typeof request.publish !== 'boolean') throw invalidRequest()
  const credentials = request.credentials === undefined ? undefined : suiteCredentialsInput(request.credentials)
  return { id: request.id, requestId: request.requestId, ...(request.groups !== undefined ? { groups: request.groups as readonly string[] } : {}), ...(request.publish !== undefined ? { publish: request.publish } : {}),
    ...(credentials && Object.keys(credentials).length ? { credentials } : {}), ...(Array.isArray(request.replace) && request.replace.length ? { replace: (request.replace as readonly SuiteReplacedEntry[]).map(row => ({ kind: row.kind, name: row.name, ...(row.revision !== undefined ? { revision: row.revision } : {}) })) } : {}) }
}

/** Resolves the per-architecture definition of a runtime dependency item. */
export function suiteRuntimeDependencyDefinition(item: SuiteCatalogRuntimeDependencyItem, architecture: SuiteCatalogArchitecture): RuntimeDependencyDefinition | undefined {
  const prepareCommand = item.prepareCommands[architecture]
  if (!prepareCommand) return undefined
  if (item.type === 'python-library') return runtimeDependencyInput({ name: item.name, type: item.type, packages: item.packages ?? [] })
  return { name: item.name, ...(item.type === 'resource' ? { type: item.type } : {}), prepareCommand, pathDirectories: [...item.pathDirectories], ...(item.checkCommand ? { checkCommand: item.checkCommand } : {}) }
}

/** Typed refusal for a signed entry this platform will not install; the view already shows the reason. */
export function suiteCatalogRefusal(reason: SuiteCatalogEntryUnavailable): BusinessRuleError {
  if (reason === 'needs-platform-upgrade') return new BusinessRuleError('invalid', 'This catalog entry requires a newer platform version.', 'suite-platform-upgrade-required')
  if (reason === 'content-tampered') return new BusinessRuleError('conflict', 'The catalog content for this version changed after it was installed.', 'suite-catalog-content-tampered')
  if (reason === 'unknown-adapter') return new BusinessRuleError('invalid', 'This catalog entry needs a platform adapter that is not available.', 'suite-adapter-unavailable')
  if (reason === 'invalid-entry') return new BusinessRuleError('invalid', 'The catalog entry failed the platform download checks.', 'suite-catalog-entry-rejected')
  if (reason === 'invalid-adapter-params') return new BusinessRuleError('invalid', 'The catalog entry has invalid adapter parameters.', 'suite-adapter-params-invalid')
  return new BusinessRuleError('invalid', 'The catalog entry content does not match its declared hash.', 'suite-catalog-integrity-failed')
}

/** Friendly name from the current online view, with an id fallback while the catalog is unreachable. */
export function suiteOriginName(origin: string, locale: 'en' | 'zh-CN' = 'en', entries: readonly Pick<SuiteCatalogSuiteEntry, 'id' | 'title'>[] = []): string {
  const entry = entries.find(row => `suite:${row.id}` === origin)
  return entry ? entry.title[locale] : origin.replace(/^suite:/u, '')
}
