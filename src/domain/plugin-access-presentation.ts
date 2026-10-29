import type { CommunityPluginAccessInput, CommunityPluginAccessView } from './admin-contract.js'
import type { PluginAccessSettings } from './plugin-access.js'

/** Structural paths contain names only, so contribution warnings never need protected YAML. */
export function pluginEntryPaths(entries: Readonly<Record<string, unknown>>, prefix = ''): readonly string[] {
  return Object.entries(entries).flatMap(([name, value]) => {
    const path = prefix + name
    return [path, ...(value && typeof value === 'object' ? pluginEntryPaths(value as Readonly<Record<string, unknown>>, path + '.') : [])]
  })
}
export function pluginAccessView(settings: PluginAccessSettings | undefined, entryIds: readonly string[]): CommunityPluginAccessView {
  return {
    environment: (settings?.environment ?? []).map(row => ({ name: row.name, configured: Boolean(row.value), last4: row.value.slice(-4) })),
    entriesYaml: { configured: Boolean(settings?.entriesYaml), last4: settings?.entriesYaml.slice(-4) ?? '' },
    entryPaths: pluginEntryPaths(settings?.entries ?? {}),
    configured: Boolean(settings),
    entryIds,
    invalidEntryIds: Object.keys(settings?.entries ?? {}).filter(id => !entryIds.includes(id)),
  }
}
export function pluginAccessWriteInput(view: CommunityPluginAccessView): CommunityPluginAccessInput {
  return { environment: view.environment.map(row => ({ name: row.name, value: '' })), entriesYaml: '' }
}
