import { isStrictSemver } from './semver.js'
import { pluginAccessObject, reservedPluginEnvironment } from './plugin-access.js'
import { assertPluginIdentity, type PluginIdentity } from './plugin-library.js'
import type { SuiteCatalogEntry, SuiteCatalogPluginItem } from './suite-catalog.js'
import type { SuiteInstallRecord } from './suite-install.js'

interface CatalogResourcePin {
  readonly dependency: string
  readonly version: string
  readonly contentHash: string
  readonly path: string
}
export type CatalogResourceBinding = CatalogResourcePin &
  (
    | { readonly kind?: 'environment'; readonly name: string }
    | { readonly kind: 'command-path'; readonly commands: readonly string[] }
    | { readonly kind: 'native-package-cache'; readonly packages: readonly PluginIdentity[] }
  )

type ResourceDefinition = {
  readonly version?: string
  readonly contentHash?: string
  readonly locked?: boolean
  readonly items: readonly {
    readonly kind: string
    readonly type?: 'resource' | 'python-library'
    readonly commands?: readonly string[]
    readonly resourceFiles?: readonly { readonly path: string; readonly executable?: true }[]
  }[]
}

export function readCatalogResourceBindings(item: SuiteCatalogPluginItem, value: unknown): readonly CatalogResourceBinding[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return
  const names = new Set(item.access.environment.map(row => row.name))
  const result: CatalogResourceBinding[] = []
  for (const row of value as readonly unknown[]) {
    if (
      !pluginAccessObject(row) ||
      Object.keys(row).some(key => !['kind', 'dependency', 'version', 'contentHash', 'name', 'path', 'packages', 'commands'].includes(key))
    )
      return
    const { kind, dependency, version, contentHash, name, path, packages, commands } = row
    if (typeof dependency !== 'string' || !item.catalogDependencies.includes(dependency) || item.runtimeDependencies.includes(dependency)) return
    if (typeof version !== 'string' || version.trim() !== version || !isStrictSemver(version)) return
    if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(contentHash) || contentHash.length !== 64) return
    if (typeof path !== 'string' || /^[A-Za-z0-9._@/-]{1,512}$/u.exec(path)?.[0] !== path) return
    if (path !== '.' && path.split('/').some(part => !part || part === '.' || part === '..')) return
    const existing = result.find(binding => binding.dependency === dependency)
    if (existing && (existing.version !== version || existing.contentHash !== contentHash)) return
    const pin = { dependency, version, contentHash, path }
    if (kind === undefined || kind === 'environment') {
      if (
        packages !== undefined ||
        commands !== undefined ||
        typeof name !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) ||
        name.trim() !== name ||
        names.has(name)
      )
        return
      if (reservedPluginEnvironment(name) || /^(LD_|DYLD_|NODE_|BASH_ENV$|ENV$)/iu.test(name)) return
      names.add(name)
      result.push({ ...pin, name, ...(kind === undefined ? {} : { kind }) })
    } else if (kind === 'command-path' && name === undefined && packages === undefined) {
      if (!Array.isArray(commands) || commands.length < 1 || commands.length > 32 || new Set(commands).size !== commands.length) return
      const valid = (command: unknown): command is string => typeof command === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.exec(command)?.[0] === command
      if (!commands.every(valid) || result.some(binding => binding.kind === kind && binding.commands.some(command => commands.includes(command)))) return
      result.push({ ...pin, kind, commands })
    } else {
      if (kind !== 'native-package-cache' || name !== undefined || commands !== undefined || result.some(binding => binding.kind === kind)) return
      const pinnedPackages = readCachePackages(packages, item.packageName)
      if (!pinnedPackages) return
      result.push({ ...pin, kind, packages: pinnedPackages })
    }
  }
  return result
}

function readCachePackages(value: unknown, owner: string): readonly PluginIdentity[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return
  const result: PluginIdentity[] = []
  const names = new Set([owner])
  for (const row of value as readonly unknown[]) {
    if (!pluginAccessObject(row) || Object.keys(row).some(key => !['packageName', 'version'].includes(key))) return
    const { packageName, version } = row
    if (
      typeof packageName !== 'string' ||
      typeof version !== 'string' ||
      packageName.trim() !== packageName ||
      version.trim() !== version ||
      names.has(packageName)
    )
      return
    const identity = { packageName, version }
    try {
      assertPluginIdentity(identity)
    } catch {
      return
    }
    names.add(packageName)
    result.push(identity)
  }
  return result
}

export function catalogResourcePin(entry: SuiteCatalogEntry, id: string): CatalogResourceBinding | undefined {
  return catalogResourceBindings(entry).find(binding => binding.dependency === id)
}

export function acceptsInstalledCatalogDependency(entry: SuiteCatalogEntry, id: string, record: SuiteInstallRecord | undefined): boolean {
  const pin = catalogResourcePin(entry, id)
  return pin ? matchesCatalogResource(pin, record) : entry.category !== 'plugin' || record?.locked !== true
}

export function catalogResourceBindingReady(binding: CatalogResourceBinding, dependency: ResourceDefinition | undefined): boolean {
  if (!dependency || !matchesCatalogResource(binding, dependency)) return false
  return dependency.items.some(item => {
    const files = item.resourceFiles ?? []
    const prefix = binding.path === '.' ? '' : binding.path + '/'
    if (binding.kind === 'native-package-cache')
      return item.type === 'resource' && ['metadata/', 'store/'].every(directory => files.some(file => file.path.startsWith(prefix + directory)))
    if (binding.kind === 'command-path')
      return (
        item.type === 'resource' &&
        !item.commands?.length &&
        binding.commands.every(command => files.some(file => file.executable && file.path === prefix + command))
      )
    return files.some(file => file.path === binding.path || file.path.startsWith(prefix))
  })
}

export function catalogResourceBindings(entry: SuiteCatalogEntry): readonly CatalogResourceBinding[] {
  if (entry.category !== 'plugin') return []
  return entry.items.find(item => item.kind === 'plugin')?.resourceBindings ?? []
}

export function matchesCatalogResource(
  binding: { readonly version?: string; readonly contentHash?: string },
  dependency: { readonly version?: string; readonly contentHash?: string; readonly locked?: boolean } | undefined,
): boolean {
  return Boolean(
    binding.version &&
    binding.contentHash &&
    dependency?.locked === true &&
    dependency.version === binding.version &&
    dependency.contentHash === binding.contentHash,
  )
}
