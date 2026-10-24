import { BusinessRuleError } from './business-error.js'
import { createHash } from 'node:crypto'
import type { CommunityPluginAccessInput } from './admin-contract.js'
export type PluginEntryConfig = Readonly<Record<string, unknown>>
export interface PluginAccessSettings extends CommunityPluginAccessInput {
  readonly entries: Readonly<Record<string, PluginEntryConfig>>
  readonly revision: string
}
/** What a catalog task needs to put a plugin's access settings exactly back: the replaced state and the revision this task applied. */
export interface PluginAccessCheckpoint {
  /** Catalog origin of the task that applied its template. */
  readonly task: string
  /** Settings in force before the task; absent when nothing was configured. */
  readonly before?: PluginAccessSettings
  /** Revision the task put in force; `none` when its template configured nothing. */
  readonly receipt?: import('./contribution-receipt.js').ContributionReceipt
  readonly appliedRevision: string
}
export const pluginAccessObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
/** Platform-owned startup variables always win; plugin-specific DSH_ variables remain usable. */
export function reservedPluginEnvironment(name: string): boolean {
  return /^(DSH_PHALANX_|LC_|DSH_TELEMETRY_)/iu.test(name) || /^(HOME|PATH|PYTHONPATH|SHELL|TMPDIR|LANG|DSH_HOME|DSH_AGENTS_HOME|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/iu.test(name)
}
export function mapPluginValues(value: unknown, transform: (value: string) => string): unknown {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map(item => mapPluginValues(item, transform))
  if (pluginAccessObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapPluginValues(item, transform)]))
  return value
}

export function samePluginAccessSnapshot(expected: readonly string[], actual: readonly string[] = []): boolean {
  return JSON.stringify([...expected].sort()) === JSON.stringify([...actual].sort())
}

/** Shared access policy; parsing is supplied by the existing YAML syntax boundary. */
export function pluginAccessConfiguration(input: CommunityPluginAccessInput, parse: (source: string) => Readonly<Record<string, PluginEntryConfig>>, entryIds: readonly string[], occupied: ReadonlySet<string>, upstreams: ReadonlySet<string>, dependencies: ReadonlySet<string> = new Set()) {
  const fail = (reason: string): never => { throw new BusinessRuleError('invalid', 'Invalid plugin access settings', 'plugin-access-invalid', { reason }) }
  if (!input || typeof input.entriesYaml !== 'string' || input.entriesYaml.length > 64 * 1024 || !Array.isArray(input.environment) || input.environment.length > 128) fail('shape')
  let entries: Readonly<Record<string, PluginEntryConfig>>
  try { entries = parse(input.entriesYaml) } catch { return fail('yaml') }
  if (Object.keys(entries).some(id => !entryIds.includes(id))) fail('entry')
  const names = new Set<string>()
  for (const row of input.environment) {
    if (!row || typeof row.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(row.name) || typeof row.value !== 'string' || row.value.length > 65536) fail('environment')
    if (reservedPluginEnvironment(row.name)) fail('reserved')
    if (occupied.has(row.name) || names.has(row.name)) fail('duplicate')
    assertPluginDependencyTemplate(row.value, dependencies)
    names.add(row.name)
  }
  mapPluginValues(entries, value => { if (value.includes('{dependency:')) fail('dependency'); return value })
  for (const { name } of pluginAccessReferences({ environment: input.environment, entries })) if (!upstreams.has(name)) fail('upstream')
  return { environment: input.environment, entriesYaml: input.entriesYaml, entries }
}
export function pluginAccessReferences(settings: { readonly environment: CommunityPluginAccessInput['environment'], readonly entries: unknown }) {
  const found: Array<{ name: string, location: string }> = []
  const walk = (value: unknown, location: string) => {
    if (typeof value === 'string') for (const match of value.matchAll(/\{upstream:([^{}]*)\}/gu)) found.push({ name: match[1]!, location })
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, `${location}.${key}`)
  }
  for (const row of settings.environment) walk(row.value, `environment.${row.name}`)
  walk(settings.entries, 'entries')
  return found
}

/** Dependency substitutions are environment-only and bind to this plugin's explicit declarations. */
export function assertPluginDependencyTemplate(value: string, dependencies: ReadonlySet<string>): void {
  const remaining = value.replace(/\{dependency:([^{}]*)\}/gu, (_, name: string) => {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,99}$/u.test(name) || !dependencies.has(name))
      throw new BusinessRuleError('invalid', 'Select the referenced runtime dependency first.', 'plugin-access-invalid', { reason: 'dependency' })
    return ''
  })
  if (remaining.includes('{dependency:')) throw new BusinessRuleError('invalid', 'Invalid dependency placeholder.', 'plugin-access-invalid', { reason: 'dependency' })
}

/** Identity of an access configuration or catalog template: environment (sorted) plus entry YAML, hashed. */
export function pluginAccessIdentity(input: Pick<CommunityPluginAccessInput, 'environment' | 'entriesYaml'>): string {
  return createHash('sha256').update(JSON.stringify([input.environment.map(row => [row.name, row.value] as const).sort(([a], [b]) => a.localeCompare(b)), input.entriesYaml])).digest('hex')
}
/** True when the settings in force are exactly this template; manual edits make it false. */
export function samePluginAccess(input: Pick<CommunityPluginAccessInput, 'environment' | 'entriesYaml'>, settings: { readonly environment: readonly { readonly name: string, readonly value: string }[], readonly entriesYaml: string } | undefined): boolean {
  return settings !== undefined && pluginAccessIdentity(input) === pluginAccessIdentity(settings)
}
