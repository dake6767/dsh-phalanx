import { parseDocument } from 'yaml'
import { pluginAccessObject, type PluginEntryConfig } from '../domain/plugin-access.js'
import { managedPluginPatch } from './managed-plugin-patch.js'

/** The official patch identities and lazy-value marker belong to this seam. */
export function mergePluginConfig(base: unknown, patch: unknown): unknown {
  if (!pluginAccessObject(base) || !pluginAccessObject(patch) || '__jsExpr' in base) return patch
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(patch)])].map(key => [key,
    Object.hasOwn(patch, key) ? mergePluginConfig(base[key], patch[key]) : base[key]]))
}

export function literalPluginAccess(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
    || Array.isArray(value) && value.every(literalPluginAccess) || pluginAccessObject(value) && Object.keys(value).every(key => key !== '__jsExpr') && Object.values(value).every(literalPluginAccess)
}
export function managedAccessEntryIds(source: string): readonly string[] {
  const document = parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }] })
  if (document.errors.length) throw Error('Invalid prepared patch')
  const prefix = 'access'
  const converted = managedPluginPatch(document.toJS({ maxAliasCount: 100 }), prefix, name => name)
  const ids: string[] = []
  for (const rows of converted.entries) visitEntries(rows, prefix, id => { ids.push(id) })
  return ids
}
export function applyManagedAccess(rows: Record<string, unknown>[], prefix: string, overrides: Readonly<Record<string, PluginEntryConfig>> = {}): void {
  visitEntries(rows, prefix, (id, entry) => { if (Object.hasOwn(overrides, id)) entry.config = mergePluginConfig(entry.config, overrides[id]) })
}
function visitEntries(rows: readonly Record<string, unknown>[], prefix: string, visit: (id: string, row: Record<string, unknown>) => void): void {
  for (const row of rows) {
    if (row.group && Array.isArray(row.config)) visitEntries(row.config as Record<string, unknown>[], prefix, visit)
    else if (typeof row.id === 'string' && row.id.startsWith(prefix + '-')) visit(row.id.slice(prefix.length + 1), row)
  }
}
