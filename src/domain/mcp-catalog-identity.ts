import { createHash } from 'node:crypto'
import type { McpPreset } from './mcp-catalog.js'
import { mcpDependency } from './mcp-dependency.js'
import type { McpService } from './mcp-service.js'
import type { RuntimeDependencyDefinition } from './runtime-dependency.js'
import { compareSemver, parseSemver } from './semver.js'
import { canonicalJson } from './suite-catalog-document.js'

// The compiled connection settings shipped by the last built-in presets.
const legacyConnectionHashes = new Map([
  ['amap', '75056ad5bcc8a58e0f56b75de570bee1800b7ba13f2da7e932ca8ddd5990d746'],
  ['12306', '35797d3538bc2843a1b8220f65b0d6b281a785770aef1bf8ba5a4f1d3db1566a'],
])

export function mcpCatalogTarget(
  service: McpService,
  preset: McpPreset | undefined,
  preparedDependency?: RuntimeDependencyDefinition,
): 'unavailable' | 'current' | 'update' {
  const source = service.catalog
  if (!source || !preset) return 'unavailable'
  const target = preset.entry
  if (source.version === target.version) {
    if (source.contentHash && source.contentHash !== target.contentHash) return 'unavailable'
    return service.configurationRequired ? 'update' : 'current'
  }
  const version = parseSemver(source.version),
    targetVersion = parseSemver(target.version)
  if (version && targetVersion && compareSemver(targetVersion, version) < 0) return 'unavailable'
  if (service.configurationRequired) return 'update'
  const historical = source.version === '1' && !source.contentHash && target.version === '1.0.0' && legacyConnectionHashes.get(source.id)
  if (!historical || historical !== connectionHash(preset.configuration)) return 'update'
  const adopted = legacyMcpConnection(service, preset, preparedDependency)
  return historical === connectionHash(adopted) ? 'current' : 'update'
}

// A persisted shared service stores its prepared command in the owned dependency row.
function legacyMcpConnection(service: McpService, preset: McpPreset, dependency: RuntimeDependencyDefinition | undefined): McpService {
  const run = service.run
  const prepareCommand = preset.configuration.run?.prepareCommand
  if (
    !run ||
    run.prepareCommand !== undefined ||
    prepareCommand === undefined ||
    !dependency ||
    dependency.name !== service.dependencyName ||
    run.runtimeDependencies?.length !== 1 ||
    run.runtimeDependencies[0] !== dependency.name
  )
    return service
  const { runtimeDependencies, ...connection } = run
  void runtimeDependencies
  const restored = { ...service, run: { ...connection, prepareCommand } }
  const expected = { ...mcpDependency(restored), name: dependency.name }
  return canonicalJson(dependency) === canonicalJson(expected) ? restored : service
}

function connectionHash(settings: McpPreset['configuration']): string {
  const { description, url, run, headers, query } = settings
  return createHash('sha256')
    .update(canonicalJson([description, url, run ?? null, headers ?? [], query ?? []]))
    .digest('hex')
}

export function consistentMcpPresets(presets: readonly McpPreset[], services: readonly McpService[]): readonly McpPreset[] {
  const sources = services.flatMap(service => [service.catalog, service.catalogUpdate?.candidate?.catalog])
  return presets.filter(
    ({ entry }) =>
      !sources.some(source => source?.id === entry.id && source.version === entry.version && source.contentHash && source.contentHash !== entry.contentHash),
  )
}

export function reusableMcpCatalogCredential(service: McpService, preset: McpPreset): string | undefined {
  if (!service.credential || !preset.entry.credentialLabel || service.run || preset.configuration.run) return
  const saved = URL.parse(service.url),
    next = URL.parse(preset.configuration.url)
  if (!saved || !next || saved.origin !== next.origin) return
  const bindings = (settings: McpPreset['configuration']) => canonicalJson([settings.headers ?? [], settings.query ?? []])
  if (bindings(service) === bindings(preset.configuration)) return service.credential
}
