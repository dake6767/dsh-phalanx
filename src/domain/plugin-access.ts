import { BusinessRuleError } from './business-error.js'
import type { CommunityPluginAccessInput } from './admin-contract.js'
export type PluginEntryConfig = Readonly<Record<string, unknown>>
export interface PluginAccessSettings extends CommunityPluginAccessInput {
  readonly entries: Readonly<Record<string, PluginEntryConfig>>
  readonly revision: string
}
export const pluginAccessObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
/** Platform-owned startup variables always win; plugin-specific DSH_ variables remain usable. */
export function reservedPluginEnvironment(name: string): boolean {
  return /^(DSH_PHALANX_|LC_|DSH_TELEMETRY_)/iu.test(name) || /^(HOME|PATH|SHELL|TMPDIR|LANG|DSH_HOME|DSH_AGENTS_HOME|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/iu.test(name)
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
export function pluginAccessConfiguration(input: CommunityPluginAccessInput, parse: (source: string) => Readonly<Record<string, PluginEntryConfig>>, entryIds: readonly string[], occupied: ReadonlySet<string>, upstreams: ReadonlySet<string>) {
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
    names.add(row.name)
  }
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
