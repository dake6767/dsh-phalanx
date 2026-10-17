import type { SuiteCatalogEntry, SuiteReplacedEntry } from '../domain/suite-catalog.js'
import type { SuiteInstallRecord } from '../domain/suite-install.js'
import { unownedManualDependency, type RuntimeDependency } from '../domain/runtime-dependency.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import type { SkillSuitePort } from './suite-entry-kinds.js'

/** What a suite install takes over in place and what blocks it, decided before the task starts. */
export interface SuiteReplacements {
  /** Manual dependencies providing a suite CLI's commands; replaced once in place after confirmation. */
  readonly dependencies: readonly { readonly item: string, readonly manual: string, readonly row: RuntimeDependency }[]
  /** Manual skills with a suite skill's name imported from the same repository. */
  readonly skills: readonly LibrarySkill[]
  /** Dependencies of the MCP catalog, another suite or a manual MCP service, or a second manual row, that provide a suite CLI's commands. */
  readonly conflicts: readonly string[]
}

export function planReplacements(entry: SuiteCatalogEntry, origin: string, dependencies: Pick<RuntimeDependencies, 'commandOwners'>, skills: Pick<SkillSuitePort, 'suiteReplaceable'>): SuiteReplacements {
  const replaced: SuiteReplacements['dependencies'][number][] = [], conflicts = new Set<string>()
  // A suite takes over the manual provider of its own CLI; a standalone catalog dependency takes over its manual twin
  // only when the administrator installs it explicitly ("switch to the catalog version"). Suites never replace a shared one.
  for (const item of entry.items) {
    if (item.kind !== 'runtime-dependency') continue
    for (const row of dependencies.commandOwners(item.commands)) {
      if (row.managedOrigin === origin) continue
      const manual = unownedManualDependency(row)
      // One manual row is taken over per CLI; a second manual provider of the same commands would still collide.
      if (manual && !replaced.some(next => next.item === item.name)) replaced.push({ item: item.name, manual: row.name, row: structuredClone(row) })
      else if (!replaced.some(next => next.manual === row.name)) conflicts.add(row.name)
    }
  }
  const skillRows = entry.items.flatMap(item => item.kind === 'skill' ? skills.suiteReplaceable(item.names, item.source.url) : [])
  return { dependencies: replaced, skills: skillRows, conflicts: [...conflicts] }
}

/** The manual entries a plan replaces, as the preview lists them and the install request confirms them. */
export function replacementEntries(plan: SuiteReplacements): readonly SuiteReplacedEntry[] {
  return [...plan.dependencies.map(row => ({ kind: 'runtime-dependency' as const, name: row.manual })), ...plan.skills.map(row => ({ kind: 'skill' as const, name: row.name }))]
}
/** True when the confirmed list is exactly what the plan would replace now. */
export function replacementConfirmed(plan: SuiteReplacements, confirmed: readonly SuiteReplacedEntry[] = []): boolean {
  const key = (row: SuiteReplacedEntry) => `${row.kind}\0${row.name}`
  const expected = new Set(replacementEntries(plan).map(key)), given = new Set(confirmed.map(key))
  return expected.size === given.size && [...expected].every(row => given.has(row))
}
/** A planned row is busy while it prepares or while another install holds it for restore. */
export function replacementBusy(plan: SuiteReplacements, installs: readonly SuiteInstallRecord[]): boolean {
  const held = new Set(installs.flatMap(row => [...row.replacing?.dependencies.map(next => `d\0${next.name}`) ?? [], ...row.replacing?.skills.map(next => `s\0${next.name}`) ?? []]))
  return plan.dependencies.some(row => row.row.stage === 'preparing' || row.row.stage === 'validating' || held.has(`d\0${row.manual}`)) || plan.skills.some(row => held.has(`s\0${row.name}`))
}
