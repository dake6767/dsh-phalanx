import { BusinessRuleError } from '../domain/business-error.js'
import { suiteRuntimeDependencyDefinition, type SuiteCatalogArchitecture, type SuiteCatalogItem, type SuiteCatalogPluginItem, type SuiteCatalogRuntimeDependencyItem, type SuiteCatalogSkillItem, type SuiteCatalogSkillPackItem, type SuiteCatalogExecutionItem, type SuiteInstallRequest } from '../domain/suite-catalog.js'
import { suiteExecutionOwner, type SuiteSkillAssignments, type SuiteExecutionSnapshot, type SuiteInstalledEntry } from '../domain/suite-install.js'
import { RuntimeDependencyPreparationFailure, type RuntimeDependencyDefinition, type RuntimeDependency, type RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import { PluginPreparationError, type LibraryPlugin, type PreparedPlugin } from '../domain/plugin-library.js'
import type { PluginAccessSettings } from '../domain/plugin-access.js'
import type { SkillPack } from '../domain/skill-pack.js'
import type { SkillGitTarget } from '../domain/skill-git-source.js'
import type { SuiteExecutionTemplate } from '../domain/platform-execution.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'

/** Suite entry kinds: each implements the same plan, prepare, commit, rollback, uninstall and detach operations. */
export interface SuiteItemPlan { readonly name: string, readonly commands?: readonly string[], readonly detail?: string }
/** What a commit may read from earlier commits in the same task. */
export interface SuiteCommitContext {
  /** Wizard-only inputs such as credentials; they are never stored in the install record. */
  readonly request: SuiteInstallRequest
  /** Library name a suite runtime-dependency item committed under (a collision may add a suffix). */
  dependencyName(item: string): string
  /** Library names of shared catalog dependencies, installed in this task or reused. */
  catalogDependencyNames(ids: readonly string[]): readonly string[]
  readonly replacement?: SuiteReplacementPlan
}
/** Manual rows a confirmed install takes over in place: dependencies keyed by catalog item name, as recorded for restore. */
export interface SuiteReplacementPlan {
  readonly dependencies: ReadonlyMap<string, RuntimeDependency>
  readonly skills: readonly LibrarySkill[]
  readonly executions: readonly SuiteExecutionSnapshot[]
  readonly plugins?: readonly { readonly row: import('../domain/plugin-library.js').LibraryPlugin, readonly revision: string }[]
}

/** Each entry kind implements plan, prepare, commit, rollback and uninstall with the same shape. */
export interface SuiteItemOperations<Item extends SuiteCatalogItem, Prepared> {
  available(item: Item): boolean
  plan(item: Item): SuiteItemPlan
  prepare(item: Item, plan: SuiteItemPlan, origin: string, log: (line: string) => Promise<void>, replacement?: SuiteReplacementPlan): Promise<Prepared>
  commit(item: Item, plan: SuiteItemPlan, prepared: Prepared, origin: string, context: SuiteCommitContext): Promise<readonly SuiteInstalledEntry[]>
  rollback(origin: string): Promise<void>
  uninstall(entry: SuiteInstalledEntry, origin: string): Promise<void>
  /** Turns one owned entry into an ordinary library entry; grants, publication and references stay as they are. */
  detach(entry: SuiteInstalledEntry, origin: string): Promise<void>
  references(entry: SuiteInstalledEntry): readonly { kind: string, name: string }[]
}

export class RuntimeDependencySuiteKind implements SuiteItemOperations<SuiteCatalogRuntimeDependencyItem, RuntimeDependencyVersion> {
  constructor(private readonly dependencies: RuntimeDependencies, private readonly architecture: () => SuiteCatalogArchitecture, private readonly signal: () => AbortSignal) {}
  available(item: SuiteCatalogRuntimeDependencyItem): boolean { return Boolean(suiteRuntimeDependencyDefinition(item, this.architecture())) }
  plan(item: SuiteCatalogRuntimeDependencyItem): SuiteItemPlan & { definition: RuntimeDependencyDefinition } {
    const definition = suiteRuntimeDependencyDefinition(item, this.architecture())
    if (!definition) throw new BusinessRuleError('invalid', 'This suite entry has no preparation for the current architecture.', 'suite-arch-unavailable')
    return { name: definition.name, commands: item.commands, definition }
  }
  async prepare(_item: SuiteCatalogRuntimeDependencyItem, plan: SuiteItemPlan & { definition: RuntimeDependencyDefinition }, _origin: string, log: (line: string) => Promise<void>): Promise<RuntimeDependencyVersion> {
    await log(`Preparing runtime dependency ${plan.name}…`)
    try { return await this.dependencies.stageManaged(plan.definition, async () => {}, this.signal()) }
    catch (error) {
      if (error instanceof RuntimeDependencyPreparationFailure) await log(error.log.trimEnd())
      throw error
    }
  }
  async commit(item: SuiteCatalogRuntimeDependencyItem, plan: SuiteItemPlan & { definition: RuntimeDependencyDefinition }, version: RuntimeDependencyVersion, origin: string, context: SuiteCommitContext): Promise<readonly SuiteInstalledEntry[]> {
    const replaced = context.replacement?.dependencies.get(item.name)
    return [{ kind: 'runtime-dependency', name: replaced ? this.dependencies.replaceManaged(origin, replaced, plan.definition, version) : this.dependencies.commitManaged(origin, plan.definition, version) }]
  }
  rollback(): Promise<void> { return this.dependencies.collectUnretained() }
  uninstall(entry: SuiteInstalledEntry, origin: string): Promise<void> { void entry; return this.dependencies.removeManaged(origin) }
  detach(entry: SuiteInstalledEntry, origin: string): Promise<void> { this.dependencies.detachManaged(origin, entry.name); return Promise.resolve() }
  references(entry: SuiteInstalledEntry) { return this.dependencies.dependencyReferences(entry.name).map(reference => ({ kind: reference.kind, name: reference.name })) }
}

export class SkillSuiteKind implements SuiteItemOperations<SuiteCatalogSkillItem, null> {
  constructor(private readonly skills: SkillSuitePort, private readonly signal: () => AbortSignal, private readonly packs: SkillPackSuitePort) {}
  available(): boolean { return true }
  plan(item: SuiteCatalogSkillItem): SuiteItemPlan {
    const source = item.source
    return { name: `${item.names.length} skills`, detail: `${source.url.replace('https://github.com/', '')} @ ${source.commit.slice(0, 7)}` }
  }
  async prepare(item: SuiteCatalogSkillItem, _plan: SuiteItemPlan, origin: string, log: (line: string) => Promise<void>, replacement?: SuiteReplacementPlan): Promise<null> {
    const source = item.source
    const target: SkillGitTarget = { url: source.url, subpath: source.path, ref: source.commit }
    await log(`Importing skills from ${source.url} @ ${source.commit.slice(0, 7)}…`)
    await this.skills.prepareSuiteImport(origin, target, item.names, log, this.signal(), replacement?.skills.map(row => row.name) ?? [])
    return null
  }
  async commit(item: SuiteCatalogSkillItem, _plan: SuiteItemPlan, _prepared: null, origin: string, context: SuiteCommitContext): Promise<readonly SuiteInstalledEntry[]> {
    const names = [...item.runtimeDependency !== undefined ? [context.dependencyName(item.runtimeDependency)] : [], ...context.catalogDependencyNames(item.catalogDependencies ?? [])]
    const rows = await this.skills.commitSuiteSkills(origin, names, context.replacement?.skills ?? [])
    return rows.map(row => ({ kind: 'skill' as const, name: row.name }))
  }
  rollback(origin: string): Promise<void> { return this.skills.discardSuiteImport(origin) }
  uninstall(entry: SuiteInstalledEntry, origin: string): Promise<void> { void entry; return this.skills.removeSuiteSkills(origin) }
  detach(entry: SuiteInstalledEntry, origin: string): Promise<void> { return this.skills.detachSuiteSkill(origin, entry.name) }
  references(entry: SuiteInstalledEntry) { return this.packs.manualPacksContaining(entry.name).map(name => ({ kind: 'skill-pack', name })) }
}

export class SkillPackSuiteKind implements SuiteItemOperations<SuiteCatalogSkillPackItem, null> {
  constructor(private readonly packs: SkillPackSuitePort) {}
  available(): boolean { return true }
  plan(item: SuiteCatalogSkillPackItem): SuiteItemPlan { return { name: item.name, detail: `${item.skills.length} skills` } }
  async prepare(): Promise<null> { return null }
  async commit(item: SuiteCatalogSkillPackItem, _plan: SuiteItemPlan, _prepared: null, origin: string): Promise<readonly SuiteInstalledEntry[]> {
    await this.packs.commitSuitePack(origin, { name: item.name, description: item.description, skills: item.skills, instructions: item.note })
    return [{ kind: 'skill-pack', name: item.name }]
  }
  rollback(): Promise<void> { return Promise.resolve() }
  uninstall(entry: SuiteInstalledEntry, origin: string): Promise<void> { void entry; return this.packs.removeSuitePack(origin) }
  detach(entry: SuiteInstalledEntry, origin: string): Promise<void> { return this.packs.detachSuitePack(origin, entry.name) }
  references(): readonly { kind: string, name: string }[] { return [] }
}

/** Delegated execution belongs to a suite skill; variable values arrive only with the install request or a later credential save. */
export class ExecutionSuiteKind implements SuiteItemOperations<SuiteCatalogExecutionItem, null> {
  constructor(private readonly execution: ExecutionSuitePort | undefined) {}
  available(): boolean { return this.execution !== undefined }
  /** The plan lists delegated command names; the detail lists the credential variables. */
  plan(item: SuiteCatalogExecutionItem): SuiteItemPlan { return { name: item.delegated.map(row => row.command).join(', '), detail: item.variables.map(row => row.name).join(', ') } }
  async prepare(): Promise<null> { return null }
  async commit(item: SuiteCatalogExecutionItem, _plan: SuiteItemPlan, _prepared: null, origin: string, context: SuiteCommitContext): Promise<readonly SuiteInstalledEntry[]> {
    await this.require().commitSuiteExecution(origin, suiteExecutionOwner(item.skill), { commands: item.delegated, variables: item.variables.map(row => row.name), optionalVariables: item.variables.filter(row => row.optional).map(row => row.name), runtimeDependencies: [context.dependencyName(item.runtimeDependency)] },
      credentialsFor(item, context.request.credentials ?? {}), context.replacement?.executions ?? [])
    return [{ kind: 'execution', name: item.skill }]
  }
  rollback(origin: string): Promise<void> { return this.execution?.removeSuiteExecution(origin) ?? Promise.resolve() }
  uninstall(_entry: SuiteInstalledEntry, origin: string): Promise<void> { return this.rollback(origin) }
  detach(entry: SuiteInstalledEntry, origin: string): Promise<void> { return this.require().detachSuiteExecution(origin, suiteExecutionOwner(entry.name)) }
  references(): readonly { kind: string, name: string }[] { return [] }
  private require(): ExecutionSuitePort {
    if (!this.execution) throw new BusinessRuleError('invalid', 'Unsupported suite entry kind.', 'suite-catalog-invalid')
    return this.execution
  }
}

/** Catalog plugin rows: one package per catalog origin, prepared and committed under the install task. */
export interface PluginSuitePort {
  /** Registers the package names persisted plugin intents hold; manual plugin changes on them stay busy. */
  observeSuiteClaims?(claims: () => readonly { packageName: string, origin: string }[]): void
  /** Same-package rows another catalog origin owns; they conflict with this entry. */
  assertSuiteAdmission(origin: string, packageName: string): void
  suitePluginConflicts(origin: string, packageName: string): readonly string[]
  /** The manual row a confirmed install takes over in place. */
  suitePluginReplaceable(packageName: string): { readonly row: LibraryPlugin, readonly revision: string } | undefined
  suitePluginRow(origin: string): LibraryPlugin | undefined
  suitePluginImpact(origin: string): { readonly name: string, readonly groups: readonly { readonly id: string, readonly name: string }[], readonly published: boolean, readonly selectedMembers: number } | undefined
  /** Access settings in force for the package under this origin; absent when nothing is configured. */
  suitePluginAccess(origin: string): PluginAccessSettings | undefined
  prepareSuitePlugin(origin: string, item: SuiteCatalogPluginItem, log: (line: string) => Promise<void>, signal: AbortSignal, expectedRevision?: string): Promise<PreparedPlugin>
  /** Writes the row and applies the catalog access template; `takeover` is the confirmed manual row. */
  commitSuitePlugin(origin: string, item: SuiteCatalogPluginItem, prepared: PreparedPlugin, runtimeDependencies: readonly string[], takeover?: LibraryPlugin): Promise<void>
  /** Puts back the row a failed task replaced, with its access settings through the task's checkpoint. */
  restoreSuitePlugin(origin: string, snapshot: { readonly row: LibraryPlugin } | { readonly packageName: string }): Promise<boolean>
  discardSuitePlugin(origin: string): Promise<void>
  removeSuitePlugin(origin: string): Promise<void>
  detachSuitePlugin(origin: string, packageName: string): Promise<void>
  /** Clears a settled task's access checkpoint; the settings it applied stay in force. */
  settleSuitePlugin?(origin: string): Promise<void>
}
/** Update steps for catalog plugins, kept apart so install-only doubles need not implement them. */
export interface PluginSuiteUpdatePort {
  suitePluginRow(origin: string): LibraryPlugin | undefined
  suitePluginAccess(origin: string): PluginAccessSettings | undefined
  prepareSuitePlugin(origin: string, item: SuiteCatalogPluginItem, log: (line: string) => Promise<void>, signal: AbortSignal, expectedRevision?: string): Promise<PreparedPlugin>
  /** Switches the owned row to the new version, applying the new template unless the administrator edited the settings. */
  updateSuitePlugin(origin: string, item: SuiteCatalogPluginItem, prepared: PreparedPlugin, runtimeDependencies: readonly string[]): Promise<void>
  restoreSuitePlugin(origin: string, snapshot: { readonly row: LibraryPlugin } | { readonly packageName: string }): Promise<boolean>
  discardSuitePlugin(origin: string): Promise<void>
  settleSuitePlugin?(origin: string): Promise<void>
}

/** A catalog plugin entry: the locked npm package, its runtime dependencies and its access template. */
export class PluginSuiteKind implements SuiteItemOperations<SuiteCatalogPluginItem, PreparedPlugin> {
  constructor(private readonly plugins: PluginSuitePort | undefined, private readonly signal: () => AbortSignal = () => new AbortController().signal) {}
  available(): boolean { return this.plugins !== undefined }
  plan(item: SuiteCatalogPluginItem): SuiteItemPlan {
    return { name: `${item.packageName}@${item.version}`, detail: item.runtimeDependencies.join(', ') }
  }
  prepare(item: SuiteCatalogPluginItem, _plan: SuiteItemPlan, origin: string, log: (line: string) => Promise<void>, replacement?: SuiteReplacementPlan): Promise<PreparedPlugin> {
    return this.require().prepareSuitePlugin(origin, item, log, this.signal(), replacement?.plugins?.[0]?.revision)
  }
  async commit(item: SuiteCatalogPluginItem, _plan: SuiteItemPlan, prepared: PreparedPlugin, origin: string, context: SuiteCommitContext): Promise<readonly SuiteInstalledEntry[]> {
    const names = [...item.runtimeDependencies.map(name => context.dependencyName(name)), ...context.catalogDependencyNames(item.catalogDependencies ?? [])]
    await this.require().commitSuitePlugin(origin, resolvedPluginItem(item, names), prepared, names, context.replacement?.plugins?.[0]?.row)
    return [{ kind: 'plugin', name: item.packageName }]
  }
  rollback(origin: string): Promise<void> { return this.require().discardSuitePlugin(origin) }
  uninstall(_entry: SuiteInstalledEntry, origin: string): Promise<void> { return this.require().removeSuitePlugin(origin) }
  detach(entry: SuiteInstalledEntry, origin: string): Promise<void> { return this.require().detachSuitePlugin(origin, entry.name) }
  references(): readonly { kind: string, name: string }[] { return [] }
  private require(): PluginSuitePort {
    if (!this.plugins) throw new BusinessRuleError('invalid', 'Unsupported suite entry kind.', 'suite-catalog-invalid')
    return this.plugins
  }
}

/** Narrow ports so tests can drive the use case with in-memory doubles. */
export interface SkillSuitePort {  prepareSuiteImport(origin: string, source: SkillGitTarget, names: readonly string[], log: (line: string) => Promise<void>, signal: AbortSignal, replacing?: readonly string[]): Promise<void>
  suiteSkillConflicts(origin: string, names: readonly string[]): readonly string[]
  commitSuiteSkills(origin: string, runtimeDependencies?: readonly string[], replacing?: readonly LibrarySkill[]): Promise<readonly { name: string }[]>
  discardSuiteImport(origin: string): Promise<void>
  removeSuiteSkills(origin: string): Promise<void>
  detachSuiteSkill(origin: string, name: string): Promise<void>
  suiteReplaceable(names: readonly string[], url: string): readonly LibrarySkill[]
  restoreSuiteSkills(origin: string, rows: readonly LibrarySkill[]): Promise<void>
  retainSuiteArtifacts?(hashes: () => readonly string[]): void
}
/** Update steps, kept apart so install-only doubles need not implement them. */
export interface SkillSuiteUpdatePort {
  suiteSkills(origin: string): readonly LibrarySkill[]
  suiteSkillConflicts(origin: string, names: readonly string[]): readonly string[]
  prepareSuiteImport(origin: string, source: SkillGitTarget, names: readonly string[], log: (line: string) => Promise<void>, signal: AbortSignal, replacing?: readonly string[], stageId?: string): Promise<void>
  discardSuiteImport(origin: string): Promise<void>
  commitSuiteUpdate(origin: string, runtimeDependencies: readonly string[], stageId?: string): Promise<readonly { name: string }[]>
  dropSuiteSkills(origin: string, names: readonly string[], checkpoint: (assignments: SuiteSkillAssignments) => void): Promise<void>
  restoreSuiteUpdate(origin: string, rows: readonly LibrarySkill[], assignments?: SuiteSkillAssignments): Promise<void>
}
export interface SkillPackSuitePort {
  commitSuitePack(origin: string, input: { name: string, description: string, skills: readonly string[], instructions: string }): Promise<void>
  removeSuitePack(origin: string): Promise<void>
  detachSuitePack(origin: string, name: string): Promise<void>
  applySuiteOptions(name: string, options: { readonly publish?: boolean, readonly groups?: readonly string[] }): Promise<void>
  suiteImpact(name: string): { groups: readonly { id: string, name: string }[], published: boolean, selectedMembers: number } | undefined
  manualPacksContaining(name: string): readonly string[]
  /** Pack names already used by a pack this suite does not own. */
  suitePackConflicts(origin: string, names: readonly string[]): readonly string[]
}
export interface SkillPackSuiteUpdatePort {
  suitePack(origin: string): SkillPack | undefined
  updateSuitePack(origin: string, input: { name: string, description: string, skills: readonly string[], instructions: string }, detached: readonly string[]): Promise<void>
  restoreSuitePack(origin: string, pack: SkillPack): Promise<void>
}
export interface ExecutionSuitePort {
  commitSuiteExecution(origin: string, owner: string, template: SuiteExecutionTemplate, credentials: Readonly<Record<string, string>>, replacing?: readonly SuiteExecutionSnapshot[]): Promise<void>
  saveSuiteCredentials(origin: string, owner: string, credentials: Readonly<Record<string, string>>): Promise<void>
  removeSuiteExecution(origin: string): Promise<void>
  detachSuiteExecution(origin: string, owner: string): Promise<void>
  suiteExecutionSnapshot(owner: string): SuiteExecutionSnapshot | undefined
  restoreSuiteExecution(origin: string, snapshot: SuiteExecutionSnapshot): Promise<void>
  finalizeSuiteExecutions(origin: string, keep: readonly { readonly owner: string, readonly variables: readonly string[] }[]): Promise<void>
  suiteExecutionStatus(owner: string): { readonly enabled: boolean, readonly configuredVariables: readonly string[], readonly missingCredentials: readonly string[] }
  delegatedCommandConflicts(owner: string, commands: readonly string[], replacing?: readonly string[]): readonly string[]
}
export interface ExecutionSuiteUpdatePort {
  suiteOwnedSnapshot(origin: string, owner: string): SuiteExecutionSnapshot | undefined
  commitSuiteExecution(origin: string, owner: string, template: SuiteExecutionTemplate, credentials: Readonly<Record<string, string>>): Promise<void>
  updateSuiteExecution(origin: string, owner: string, template: SuiteExecutionTemplate): Promise<void>
  restoreSuiteUpdate(origin: string, snapshot: SuiteExecutionSnapshot): Promise<void>
  removeSuiteExecution(origin: string): Promise<void>
  finalizeSuiteExecutions(origin: string, keep: readonly { readonly owner: string, readonly variables: readonly string[] }[]): Promise<void>
}

/** Keeps only the values this execution item declares. */
export function credentialsFor(item: SuiteCatalogExecutionItem, credentials: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const names = new Set(item.variables.map(row => row.name))
  return Object.fromEntries(Object.entries(credentials).filter(([name]) => names.has(name)))
}

/** Resolves declarative dependency names to the library names selected by this task. */
export function resolvedPluginItem(item: SuiteCatalogPluginItem, names: readonly string[]): SuiteCatalogPluginItem {
  const declared = [...item.runtimeDependencies, ...item.catalogDependencies]
  return { ...item, access: { ...item.access, environment: item.access.environment.map(row => ({ ...row,
    value: row.value.replace(/\{dependency:([^{}]+)\}/gu, (token, name: string) => { const index = declared.indexOf(name); return index < 0 ? token : `{dependency:${names[index]}}` }) })) } }
}

/** Stable preparation failures survive catalog transaction rollback without message inspection. */
export function suitePreparationFailure(error: unknown): string { return error instanceof RuntimeDependencyPreparationFailure || error instanceof BusinessRuleError || error instanceof PluginPreparationError ? error.code : 'prepare-failed' }
