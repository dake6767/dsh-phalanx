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
