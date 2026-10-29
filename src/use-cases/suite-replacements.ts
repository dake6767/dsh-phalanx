import type { SuiteCatalogEntry, SuiteReplacedEntry } from '../domain/suite-catalog.js'
import { suiteInstallOrigin, type SuiteInstallRecord } from '../domain/suite-install.js'
import { unownedManualDependency, type RuntimeDependency } from '../domain/runtime-dependency.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { LibraryPlugin } from '../domain/plugin-library.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import type { PluginSuitePort, SkillSuitePort } from './suite-entry-kinds.js'

/** What a suite install takes over in place and what blocks it, decided before the task starts. */
export interface SuiteReplacements {
  /** Manual dependencies providing a suite CLI's commands; replaced once in place after confirmation. */
  readonly dependencies: readonly { readonly item: string; readonly manual: string; readonly row: RuntimeDependency }[]
  /** Manual skills with a suite skill's name imported from the same repository. */
  readonly skills: readonly LibrarySkill[]
  /** Manual plugins with a catalog plugin's package name, with their access settings for restore. */
  readonly plugins: readonly { readonly row: LibraryPlugin; readonly revision: string }[]
  /** Dependencies of the MCP catalog, another suite or a manual MCP service, or a second manual row, that provide a suite CLI's commands. */
  readonly conflicts: readonly string[]
}

export async function planReplacements(
  entry: SuiteCatalogEntry,
  origin: string,
  dependencies: Pick<RuntimeDependencies, 'commandOwners'>,
  skills: Pick<SkillSuitePort, 'suiteReplaceable'>,
  plugins?: Pick<PluginSuitePort, 'suitePluginConflicts' | 'suitePluginReplaceable'>,
): Promise<SuiteReplacements> {
  const replaced: SuiteReplacements['dependencies'][number][] = [],
    conflicts = new Set<string>()
  // A suite takes over the manual provider of its own CLI; a standalone catalog dependency takes over its manual twin
  // only when the administrator installs it explicitly ("switch to the catalog version"). Suites never replace a shared one.
  for (const item of entry.items) {
    if (item.kind !== 'runtime-dependency') continue
    for (const row of await dependencies.commandOwners(item.commands, item.type === 'python-library')) {
      if (row.managedOrigin === origin) continue
      const manual = unownedManualDependency(row)
      // One manual row is taken over per CLI; a second manual provider of the same commands would still collide.
      if (manual && !replaced.some(next => next.item === item.name)) replaced.push({ item: item.name, manual: row.name, row: structuredClone(row) })
      else if (!replaced.some(next => next.manual === row.name)) conflicts.add(row.name)
    }
  }
  // A catalog plugin takes over the manual row of the same package; a row another catalog origin owns conflicts.
  const pluginRows: SuiteReplacements['plugins'][number][] = []
  for (const item of entry.items) {
    if (item.kind !== 'plugin') continue
    if ((await plugins?.suitePluginConflicts(origin, item.packageName))?.length) {
      conflicts.add(item.packageName)
      continue
    }
    const replaceable = await plugins?.suitePluginReplaceable(item.packageName)
    if (replaceable) pluginRows.push({ row: replaceable.row, revision: replaceable.revision })
  }
  const skillRows = (
    await Promise.all(entry.items.map(async item => (item.kind === 'skill' ? await skills.suiteReplaceable(item.names, item.source.url) : [])))
  ).flat()
  return { dependencies: replaced, skills: skillRows, plugins: pluginRows, conflicts: [...conflicts] }
}

/** The manual entries a plan replaces, as the preview lists them and the install request confirms them. */
export function replacementEntries(plan: SuiteReplacements): readonly SuiteReplacedEntry[] {
  return [
    ...plan.dependencies.map(row => ({ kind: 'runtime-dependency' as const, name: row.manual })),
    ...plan.skills.map(row => ({ kind: 'skill' as const, name: row.name })),
    ...plan.plugins.map(row => ({ kind: 'plugin' as const, name: row.row.packageName, revision: row.revision })),
  ]
}
/** True when the confirmed list is exactly what the plan would replace now. */
export function replacementConfirmed(plan: SuiteReplacements, confirmed: readonly SuiteReplacedEntry[] = []): boolean {
  const key = (row: SuiteReplacedEntry) => `${row.kind}\0${row.name}\0${row.revision ?? ''}`
  const expected = new Set(replacementEntries(plan).map(key)),
    given = new Set(confirmed.map(key))
  return expected.size === given.size && [...expected].every(row => given.has(row))
}
/** Prepared takeover leases hold names, never snapshots of mutable business facts. */
export function replacementBusy(plan: SuiteReplacements, held: readonly SuiteReplacedEntry[]): boolean {
  const has = (kind: SuiteReplacedEntry['kind'], name: string) => held.some(row => row.kind === kind && row.name === name)
  return (
    plan.dependencies.some(row => row.row.stage === 'preparing' || row.row.stage === 'validating' || has('runtime-dependency', row.manual)) ||
    plan.skills.some(row => has('skill', row.name)) ||
    plan.plugins.some(row => has('plugin', row.row.packageName))
  )
}

/** Shared dependency plan, read once before a catalog task persists its intent. */
export async function planSharedDependencies(
  entry: SuiteCatalogEntry,
  entries: readonly SuiteCatalogEntry[],
  installs: readonly SuiteInstallRecord[],
  dependencies: Pick<RuntimeDependencies, 'manualProviders' | 'commandOwners'>,
) {
  if (entry.category === 'dependency') return { install: [], reuse: [], manual: [], conflicts: [], missing: [], busy: false }
  const install: { entry: SuiteCatalogEntry; previous?: SuiteInstallRecord }[] = [],
    reuse: string[] = [],
    manual: { id: string; name: string }[] = [],
    conflicts: string[] = [],
    missing: string[] = []
  let busy = false
  for (const id of entry.dependencies) {
    const record = installs.find(row => row.id === id)
    const dependency = entries.find(row => row.id === id)
    // A signed catalog must declare every shared dependency needed to install the suite.
    if (!dependency) {
      missing.push(id)
      continue
    }
    // A manual dependency that already provides every command is used as it is; the catalog copy is not installed.
    const commands = dependency.items.flatMap(item => (item.kind === 'runtime-dependency' ? item.commands : []))
    const libraries = dependency.items.filter(item => item.kind === 'runtime-dependency')
    const python = libraries.length > 0 && libraries.every(item => item.type === 'python-library')
    const own = (await dependencies.manualProviders(commands, python ? libraries.flatMap(item => item.packages ?? []) : undefined))[0]
    if (record?.status === 'installed') reuse.push(id)
    else if (record && record.status !== 'failed') busy = true
    else if (own) manual.push({ id, name: own.name })
    else {
      // Any other provider (MCP catalog, a manual MCP service, a partial manual twin) would make the commit fail late.
      const blocking = (await dependencies.commandOwners(commands, python)).filter(row => row.managedOrigin !== suiteInstallOrigin(id)).map(row => row.name)
      if (blocking.length) conflicts.push(...blocking)
      else install.push({ entry: dependency, ...(record ? { previous: record } : {}) })
    }
  }
  return { install, reuse, manual, conflicts, missing, busy }
}
