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

/** Structural superset of catalog entries so suite shapes arriving in later tickets stay checkable. */
export interface SuiteCatalogCheckEntry {
  readonly id: string
  readonly category: 'dependency' | 'suite'
  readonly items: readonly { readonly kind: string, readonly commands?: readonly string[], readonly prepareCommands?: Readonly<Partial<Record<SuiteCatalogArchitecture, string>>> }[]
  readonly dependencies?: readonly string[]
  readonly skills?: readonly { readonly type: string, readonly url: string, readonly commit: string }[]
}

/** Every rule a catalog entry must satisfy before it ships with a release. */
export function suiteCatalogViolations(entries: readonly SuiteCatalogCheckEntry[]): readonly string[] {
  const violations: string[] = []
  const dependencies = new Set(entries.filter(entry => entry.category === 'dependency').map(entry => entry.id))
  for (const entry of entries) {
    for (const command of entry.items.flatMap(item => Object.values(item.prepareCommands ?? {})).filter((command): command is string => Boolean(command))) {
      for (const host of [...command.matchAll(urlPattern)].map(match => match[1]!.toLowerCase())) if (!downloadHosts.has(host)) violations.push(`${entry.id}: download host ${host} is outside the five download-source classes`)
      const downloads = [...command.matchAll(/\b(?:curl|wget)\b/gu)].length
      const checksums = new Set([...command.matchAll(/\b[a-f0-9]{64}\b/gu)])
      if (downloads > checksums.size) violations.push(`${entry.id}: ${downloads} downloads but only ${checksums.size} sha256 checksums`)
    }
    for (const skill of entry.skills ?? []) {
      if (skill.type !== 'git' || !/^https:\/\/github\.com\//u.test(skill.url) || !/^[0-9a-f]{40}$/u.test(skill.commit)) violations.push(`${entry.id}: skill source ${skill.url || '(missing url)'} must pin a Git repository to a 40-hex commit`)
    }
    for (const dependency of entry.dependencies ?? []) if (!dependencies.has(dependency)) violations.push(`${entry.id}: requires unknown catalog dependency ${dependency}`)
  }
  const providers = new Map<string, string>()
  for (const entry of entries) for (const item of entry.items) for (const [architecture, prepared] of Object.entries(item.prepareCommands ?? {}) as readonly [SuiteCatalogArchitecture, string?][]) {
    if (!prepared) continue
    for (const command of item.commands ?? []) {
      const owner = providers.get(`${architecture}:${command}`)
      if (owner !== undefined && owner !== entry.id) violations.push(`${entry.id}: command ${command} conflicts with ${owner} on ${architecture}`)
      else providers.set(`${architecture}:${command}`, entry.id)
    }
  }
  return [...new Set(violations)]
}
