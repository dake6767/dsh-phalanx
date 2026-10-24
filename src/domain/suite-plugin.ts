import { assertPluginIdentity } from './plugin-library.js'
import type { SuiteCatalogPluginItem } from './suite-catalog.js'

/** Catalog plugin declarations never carry administrator credentials. */
export function readCatalogPluginItem(value: Record<string, unknown>): SuiteCatalogPluginItem {
  const { packageName, version, integrity } = value
  assertPluginIdentity({ packageName, version } as { packageName: string, version: string })
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)) throw Error('Invalid plugin integrity')
  const names = (input: unknown): readonly string[] => {
    if (!Array.isArray(input) || input.length > 64 || input.some(name => typeof name !== 'string' || !name || name.length > 128) || new Set(input).size !== input.length) throw Error('Invalid plugin dependencies')
    return input as string[]
  }
  const access = value.access as SuiteCatalogPluginItem['access']
  if (!access || !Array.isArray(access.environment) || access.environment.length > 64 || typeof access.entriesYaml !== 'string' || access.entriesYaml.length > 65536
    || access.environment.some(row => !row || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(row.name) || typeof row.value !== 'string' || row.value.length > 4096 || row.value.includes('\0'))) throw Error('Invalid plugin access template')
  return { kind: 'plugin', packageName: packageName as string, version: version as string, integrity,
    runtimeDependencies: names(value.runtimeDependencies), catalogDependencies: names(value.catalogDependencies),
    access: { environment: access.environment.map(row => ({ name: row.name, value: row.value })), entriesYaml: access.entriesYaml } }
}
