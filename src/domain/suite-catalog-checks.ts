import { pythonPackagePin, pythonPackagePins } from './python-library.js'
import type { SuiteCatalogArchitecture } from './suite-catalog.js'

/** Hosts the five download-source classes cover; mirrors the bundled download-source presets. */
const downloadHosts = new Set([
  'registry.npmjs.org', 'registry.npmmirror.com',                                   // npm
  'pypi.org', 'pypi.tuna.tsinghua.edu.cn',                                          // PyPI
  'docker.m.daocloud.io',                                                           // container mirror
  'ghcr.nju.edu.cn',                                                                // GHCR mirror
  'github.com', 'codeload.github.com', 'objects.githubusercontent.com',             // GitHub assets
  'cdn.playwright.dev',                                                             // browser
])
const urlPattern = /https?:\/\/([A-Za-z0-9.-]+)(?:[/:?#][^\s'"]*)?/gu
/** Download-source prefix variables; every fetch line must go through one of them. */
const downloadPrefixes = ['${GITHUB_ASSETS_PREFIX}', '${PLAYWRIGHT_DOWNLOAD_HOST', '${PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST']
const registryBypass = /(?:npm install|npx|pnpm add|yarn add)[^\n]*--registry|pip[0-9.]* install[^\n]*(?:-i\s|--index-url)/u
/**
 * Registry packages carry no file checksum in the catalog. npm fetches with registry integrity metadata, so an
 * exact version pin keeps the install immutable; PyPI has no per-file hash here, so its exact pin is the only
 * guarantee. File downloads (github-assets/browser) are the ones that must also carry a sha256 in the command.
 */
const exactNpmSpec = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const packageArguments = (line: string, prefix: RegExp): readonly string[] => {
  const match = prefix.exec(line)
  if (!match) return []
  return line.slice(match[0].length).split(/\s+/u).filter(token => token !== '' && !token.startsWith('-') && !/[$"']/u.test(token))
}

/** Structural superset of catalog entries so suite shapes arriving in later tickets stay checkable. */
export interface SuiteCatalogCheckEntry {
  readonly id: string
  readonly category: 'dependency' | 'suite' | 'plugin'
  readonly items: readonly { readonly kind: string, readonly type?: 'python-library' | 'resource', readonly packages?: readonly string[], readonly name?: string, readonly commands?: readonly string[], readonly prepareCommands?: Readonly<Partial<Record<SuiteCatalogArchitecture, string>>>,
    readonly source?: { readonly type: string, readonly url: string, readonly commit: string }, readonly names?: readonly string[], readonly skill?: string, readonly runtimeDependency?: string,
    readonly version?: string, readonly packageName?: string, readonly integrity?: string, readonly access?: import('./admin-contract.js').CommunityPluginAccessInput, readonly runtimeDependencies?: readonly string[], readonly catalogDependencies?: readonly string[] }[]
  readonly dependencies?: readonly string[]
  readonly skills?: readonly { readonly type: string, readonly url: string, readonly commit: string }[]
}

/**
 * Rules one catalog entry must satisfy on its own, including every generated download command.
 * Exported for the online reader, which refuses a non-conforming signed entry instead of installing it.
 */
export function suiteEntryViolations(entry: SuiteCatalogCheckEntry): readonly string[] {
  const violations: string[] = []
  const plugins = entry.items.filter(item => item.kind === 'plugin')
  if (entry.category === 'plugin' ? plugins.length !== 1 || entry.items.some(item => item.kind !== 'plugin' && item.kind !== 'runtime-dependency') : plugins.length > 0) violations.push(`${entry.id}: plugin entries contain exactly one plugin and optional runtime dependencies`)
  for (const plugin of plugins) for (const name of plugin.runtimeDependencies ?? []) if (!entry.items.slice(0, entry.items.indexOf(plugin)).some(item => item.kind === 'runtime-dependency' && item.name === name)) violations.push(`${entry.id}: plugin dependency ${name} must be declared before its plugin`)
  for (const item of entry.items) if (item.type === 'python-library' && !pythonPackagePins(item.packages)) violations.push(`${entry.id}: Python libraries must list exact, non-conflicting PyPI versions`)
  for (const command of entry.items.flatMap(item => Object.values(item.prepareCommands ?? {})).filter((command): command is string => Boolean(command))) {
    if (command.length > 128 * 1024) violations.push(`${entry.id}: preparation command exceeds the 128 KiB runtime dependency limit`)
    // Only download commands fetch at preparation time; wrapper scripts may name the service endpoints they call later.
    const downloadLines = command.split('\n').filter(line => /\b(?:curl|wget)(?=\s|$)/u.test(line)).join('\n')
    for (const host of [...downloadLines.matchAll(urlPattern)].map(match => match[1]!.toLowerCase())) if (!downloadHosts.has(host)) violations.push(`${entry.id}: download host ${host} is outside the five download-source classes`)
    const downloads = [...command.matchAll(/\b(?:curl|wget)(?=\s|$)/gu)].length
    const checksums = new Set([...command.matchAll(/\b[a-f0-9]{64}\b/gu)])
    if (downloads > checksums.size) violations.push(`${entry.id}: ${downloads} downloads but only ${checksums.size} sha256 checksums`)
    for (const line of command.split('\n')) {
      if (!/\b(?:curl|wget)(?=\s|$)/u.test(line)) continue
      if (!downloadPrefixes.some(prefix => line.includes(prefix))) violations.push(`${entry.id}: a download bypasses the download-source prefix variable`)
    }
    if (registryBypass.test(command)) violations.push(`${entry.id}: a registry install overrides the configured download source`)
    for (const line of command.split('\n')) {
      for (const spec of packageArguments(line, /^\s*npm install\b/u)) if (!exactNpmSpec.test(spec)) violations.push(`${entry.id}: npm package ${spec} must pin an exact version`)
      for (const spec of packageArguments(line, /^\s*(?:python3?|pip[0-9.]*)(?: -m pip)? install\b/u)) if (!pythonPackagePin(spec)) violations.push(`${entry.id}: PyPI package ${spec} must pin an exact version`)
    }
  }
  for (const skill of [...entry.skills ?? [], ...entry.items.flatMap(item => item.kind === 'skill' && item.source ? [item.source] : [])]) {
    // Only GitHub repositories are an accepted catalog source, matching the 0.1.18 skill policy.
    if (skill.type !== 'git' || !/^https:\/\/github\.com\//u.test(skill.url) || !/^[0-9a-f]{40}$/u.test(skill.commit)) violations.push(`${entry.id}: skill source ${skill.url || '(missing url)'} must pin a Git repository to a 40-hex commit`)
  }
  const skills = new Set(entry.items.flatMap(item => item.kind === 'skill' ? item.names ?? [] : []))
  const tools = new Set(entry.items.flatMap(item => item.kind === 'runtime-dependency' && item.name ? [item.name] : []))
  entry.items.forEach((item, index) => {
    if (item.kind !== 'execution') return
    if (!item.skill || !skills.has(item.skill)) violations.push(`${entry.id}: delegated execution belongs to unknown suite skill ${item.skill ?? '(missing)'}`)
    // Items commit in order, and a configuration needs its owning skill to exist first.
    else if (!entry.items.slice(0, index).some(prior => prior.kind === 'skill' && prior.names?.includes(item.skill!))) violations.push(`${entry.id}: delegated execution for ${item.skill} must follow its skill item`)
    if (!item.runtimeDependency || !tools.has(item.runtimeDependency)) violations.push(`${entry.id}: delegated execution uses unknown suite runtime dependency ${item.runtimeDependency ?? '(missing)'}`)
  })
  for (const item of entry.items) for (const id of item.catalogDependencies ?? []) if (!(entry.dependencies ?? []).includes(id)) violations.push(`${entry.id}: skills use catalog dependency ${id} that the suite does not declare`)
  return violations
}

/** Every rule a full catalog must satisfy; exported for the catalog repository CI (ticket 08). */
export function suiteCatalogViolations(entries: readonly SuiteCatalogCheckEntry[]): readonly string[] {
  const violations: string[] = []
  const dependencies = new Set(entries.filter(entry => entry.category === 'dependency').map(entry => entry.id))
  for (const entry of entries) {
    violations.push(...suiteEntryViolations(entry))
    for (const dependency of entry.dependencies ?? []) if (!dependencies.has(dependency)) violations.push(`${entry.id}: requires unknown catalog dependency ${dependency}`)
  }
  const providers = new Map<string, { entry: string, python: boolean }>()
  const packages = new Map<string, { entry: string, identity: string }>()
  for (const entry of entries) for (const item of entry.items) for (const [architecture, prepared] of Object.entries(item.prepareCommands ?? {}) as readonly [SuiteCatalogArchitecture, string?][]) {
    if (!prepared) continue
    for (const spec of item.type === 'python-library' ? item.packages ?? [] : []) {
      const pin = pythonPackagePin(spec)
      if (!pin) continue
      const key = `${architecture}:${pin.name}`, owner = packages.get(key)
      if (owner && owner.identity !== pin.identity) violations.push(`${entry.id}: Python package ${pin.name} conflicts with ${owner.entry} on ${architecture}`)
      else packages.set(key, { entry: entry.id, identity: pin.identity })
    }
    for (const command of item.commands ?? []) {
      const owner = providers.get(`${architecture}:${command}`)
      if (owner !== undefined && owner.entry !== entry.id && !(command === 'python3' && owner.python && item.type === 'python-library')) violations.push(`${entry.id}: command ${command} conflicts with ${owner.entry} on ${architecture}`)
      else providers.set(`${architecture}:${command}`, { entry: entry.id, python: item.type === 'python-library' })
    }
  }
  return [...new Set(violations)]
}
