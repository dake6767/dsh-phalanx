import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunitySuiteUpdatePreview } from '../domain/admin-contract.js'
import { suiteRuntimeDependencyDefinition, type SuiteCatalogArchitecture, type SuiteCatalogEntry, type SuiteCatalogExecutionItem, type SuiteCatalogRuntimeDependencyItem, type SuiteCatalogSkillItem, type SuiteCatalogSkillPackItem } from '../domain/suite-catalog.js'
import { compareSuiteVersions, suiteExecutionOwner, suiteInstallOrigin, type SuiteInstalledEntry, type SuiteInstallRecord, type SuiteUpdateSnapshot, type SuiteSkillAssignments } from '../domain/suite-install.js'
import { RuntimeDependencyPreparationFailure } from '../domain/runtime-dependency.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import type { ExecutionSuiteUpdatePort, SkillPackSuiteUpdatePort, SkillSuiteUpdatePort } from './suite-entry-kinds.js'

/** What an update reads from the install record and the catalog; the use case owns the record itself. */
export interface SuiteUpdateContext {
  readonly record: SuiteInstallRecord
  readonly entry: SuiteCatalogEntry
  readonly installs: readonly SuiteInstallRecord[]
  /** Library name of an installed shared catalog dependency, or the manual one a suite uses instead. */
  catalogDependencyName(id: string): string | undefined
}

/** Plans and runs the update of one installed entry to its catalog version; old rows stay until every step is ready. */
export class SuiteUpdates {
  constructor(private readonly dependencies: RuntimeDependencies, private readonly architecture: SuiteCatalogArchitecture, private readonly signal: () => AbortSignal,
    private readonly skills: SkillSuiteUpdatePort, private readonly packs: SkillPackSuiteUpdatePort, private readonly execution?: ExecutionSuiteUpdatePort) {}

  preview(context: SuiteUpdateContext): CommunitySuiteUpdatePreview {
    const { record, entry } = context, origin = suiteInstallOrigin(entry.id), detached = record.detached ?? []
    const skip = (kind: SuiteInstalledEntry['kind'], name: string) => detached.some(row => row.kind === kind && row.name === name)
    const tool = this.tool(entry), installedTool = record.entries.find(row => row.kind === 'runtime-dependency')
    const current = installedTool ? this.dependencies.managedRows(origin).find(row => row.name === installedTool.name) : undefined
    const definition = tool ? suiteRuntimeDependencyDefinition(tool, this.architecture) : undefined
    const oldSkills = this.skills.suiteSkills(origin), names = this.skillItems(entry).flatMap(item => item.names).filter(name => !skip('skill', name))
    const commitOf = (name: string) => this.skillItems(entry).find(item => item.names.includes(name))?.source.commit
    const pack = this.packItem(entry), installedPack = this.packs.suitePack(origin)
    const oldExecution = record.entries.flatMap(row => {
      const snapshot = row.kind === 'execution' ? this.execution?.suiteOwnedSnapshot(origin, suiteExecutionOwner(row.name)) : undefined
      return snapshot ? [snapshot] : []
    })
    const newExecution = this.executionItems(entry).filter(item => !skip('execution', item.skill) && !skip('skill', item.skill))
    const oldCommands = oldExecution.flatMap(item => item.commands), nextCommands = newExecution.flatMap(item => item.delegated)
    const oldVariables = oldExecution.flatMap(item => item.variables), nextVariables = newExecution.flatMap(item => item.variables)
    const commands = { added: nextCommands.filter(row => !oldCommands.some(old => old.command === row.command)).map(row => row.command),
      removed: oldCommands.filter(row => !nextCommands.some(next => next.command === row.command)).map(row => row.command),
      changed: nextCommands.filter(row => { const old = oldCommands.find(next => next.command === row.command); return old && old.blocked.join(' ') !== row.blocked.join(' ') }).map(row => row.command) }
    const variables = { added: nextVariables.filter(row => !oldVariables.some(old => old.name === row.name)).map(row => row.name),
      removed: oldVariables.filter(row => !nextVariables.some(next => next.name === row.name)).map(row => row.name) }
    // A skill the new version adds may meanwhile exist in the library under another origin.
    const conflicts = this.skills.suiteSkillConflicts(origin, names)
    const missing = entry.category === 'suite' ? entry.dependencies.filter(id => context.catalogDependencyName(id) === undefined) : []
    const reason = compareSuiteVersions(entry.version, record.version) <= 0 ? 'up-to-date' : (tool && !definition) ? 'unavailable-architecture'
      : conflicts.length ? 'skill-conflicts' : missing.length ? 'dependency-missing' : undefined
    return { id: entry.id, from: record.version, to: entry.version, ...(reason ? { reason } : {}),
      ...(tool && installedTool && !skip('runtime-dependency', installedTool.name) ? { dependency: { name: installedTool.name, changed: !current || definition?.prepareCommand !== current.prepareCommand || definition.checkCommand !== current.checkCommand || definition.pathDirectories.join('\0') !== current.pathDirectories.join('\0') } } : {}),
      skills: { added: names.filter(name => !oldSkills.some(row => row.name === name)), removed: oldSkills.map(row => row.name).filter(name => !names.includes(name)),
        updated: oldSkills.filter(row => names.includes(row.name) && row.source?.commit !== commitOf(row.name)).map(row => row.name) },
      ...(pack && installedPack && !skip('skill-pack', installedPack.name) ? { pack: { name: pack.name, added: pack.skills.filter(name => !installedPack.skills.includes(name) && !skip('skill', name)), removed: installedPack.skills.filter(name => !pack.skills.includes(name) && !skip('skill', name)) } } : {}),
      ...(newExecution.length || oldExecution.length ? { execution: { commands, variables } } : {}),
      dependents: entry.category === 'dependency' ? context.installs.filter(row => row.dependencies?.includes(entry.id)).map(row => row.id) : [],
      skipped: detached, manualDependencies: record.manualDependencies ?? [],
      ...(conflicts.length ? { conflicts } : {}), ...(missing.length ? { missingDependencies: missing } : {}) }
  }
  /** Captures every row the update may change, before the task starts. */
  snapshot(record: SuiteInstallRecord): SuiteUpdateSnapshot {
    const origin = suiteInstallOrigin(record.id), pack = this.packs.suitePack(origin)
    const executions = record.entries.flatMap(row => { const snapshot = row.kind === 'execution' ? this.execution?.suiteOwnedSnapshot(origin, suiteExecutionOwner(row.name)) : undefined; return snapshot ? [snapshot] : [] })
    return { version: record.version, ...(record.contentHash ? { contentHash: record.contentHash } : {}), entries: record.entries, ...(record.dependencies ? { dependencies: record.dependencies } : {}), dependencyRows: this.dependencies.managedRows(origin),
      skills: this.skills.suiteSkills(origin), ...(pack ? { pack } : {}), executions }
  }
  /** Prepares everything first, then switches; returns the entries now installed. Throws with the old rows untouched before the switch. */
  async run(context: SuiteUpdateContext, log: (line: string) => Promise<void>, checkpoint: (assignments: SuiteSkillAssignments) => void): Promise<readonly SuiteInstalledEntry[]> {
    const { record, entry } = context, origin = suiteInstallOrigin(entry.id), detached = record.detached ?? []
    const skip = (kind: SuiteInstalledEntry['kind'], name: string) => detached.some(row => row.kind === kind && row.name === name)
    const preview = this.preview(context)
    if (preview.reason) throw new BusinessRuleError('conflict', 'This entry cannot be updated now.', preview.reason === 'up-to-date' ? 'suite-up-to-date' : preview.reason === 'dependency-missing' ? 'suite-dependency-missing' : preview.reason === 'skill-conflicts' ? 'suite-skill-conflict' : 'suite-arch-unavailable')
    const tool = this.tool(entry), definition = tool ? suiteRuntimeDependencyDefinition(tool, this.architecture) : undefined
    const toolName = [...record.entries, ...detached].find(row => row.kind === 'runtime-dependency')?.name
    // 1. Prepare: a new runtime dependency version (tested by its check command) and the skills at the new commit.
    let version: Awaited<ReturnType<RuntimeDependencies['stageManaged']>> | undefined
    if (definition && preview.dependency?.changed) {
      await log(`Preparing runtime dependency ${definition.name}…`)
      try { version = await this.dependencies.stageManaged(definition, async () => {}, this.signal()) }
      catch (error) { if (error instanceof RuntimeDependencyPreparationFailure) await log(error.log.trimEnd()); throw error }
    }
    const skillItems = this.skillItems(entry).map(item => ({ ...item, names: item.names.filter(name => !skip('skill', name)) })).filter(item => item.names.length)
    const stages = skillItems.map((item, index) => ({ item, id: `${origin}:update:${index}` }))
    try {
      for (const { item, id } of stages) {
        await log(`Importing skills from ${item.source.url} @ ${item.source.commit.slice(0, 7)}…`)
        await this.skills.prepareSuiteImport(origin, { url: item.source.url, subpath: item.source.path, ref: item.source.commit }, item.names, log, this.signal(), [], id)
      }
      // 2. Switch: dependency, skills, pack, delegated execution; the caller restores the snapshot if any step fails.
      await log('Switching to the new version…')
      if (version && definition && toolName) this.dependencies.updateManaged(origin, toolName, { ...definition, name: toolName }, version)
      const dependencyName = (item: string) => item === tool?.name && toolName ? toolName : item
      const committed: SuiteInstalledEntry[] = []
      for (const { item, id } of stages) {
        const references = [...item.runtimeDependency !== undefined ? [dependencyName(item.runtimeDependency)] : [], ...(item.catalogDependencies ?? []).map(id => context.catalogDependencyName(id)!)]
        committed.push(...(await this.skills.commitSuiteUpdate(origin, references, id)).map(row => ({ kind: 'skill' as const, name: row.name })))
      }
      const pack = this.packItem(entry)
      if (pack && !skip('skill-pack', pack.name)) await this.packs.updateSuitePack(origin, { name: pack.name, description: pack.description, skills: pack.skills.filter(name => !skip('skill', name)), instructions: pack.note }, detached.filter(row => row.kind === 'skill').map(row => row.name))
      const executions: SuiteInstalledEntry[] = []
      for (const item of this.executionItems(entry)) {
        if (skip('execution', item.skill) || skip('skill', item.skill)) continue
        const owner = suiteExecutionOwner(item.skill), template = { commands: item.delegated, variables: item.variables.map(row => row.name), runtimeDependencies: [dependencyName(item.runtimeDependency)] }
        if (this.execution?.suiteOwnedSnapshot(origin, owner)) await this.execution.updateSuiteExecution(origin, owner, template)
        else await this.execution?.commitSuiteExecution(origin, owner, template, {})
        executions.push({ kind: 'execution', name: item.skill })
      }
      // Skills the new version dropped go last, so nothing they referenced disappears before the rest switched.
      await this.skills.dropSuiteSkills(origin, preview.skills.removed, checkpoint)
      return [...toolName && !skip('runtime-dependency', toolName) ? [{ kind: 'runtime-dependency' as const, name: toolName }] : [], ...committed,
        ...pack && !skip('skill-pack', pack.name) ? [{ kind: 'skill-pack' as const, name: pack.name }] : [], ...executions]
    } finally { for (const { id } of stages) await this.skills.discardSuiteImport(id).catch(() => {}) }
  }
  /** Puts back every row the snapshot holds; rows the update added are removed. */
  async restore(id: string, snapshot: SuiteUpdateSnapshot): Promise<void> {
    const origin = suiteInstallOrigin(id)
    for (const row of snapshot.dependencyRows) this.dependencies.restoreManaged(origin, row)
    await this.skills.restoreSuiteUpdate(origin, snapshot.skills, snapshot.assignments)
    if (snapshot.pack) await this.packs.restoreSuitePack(origin, snapshot.pack)
    for (const execution of snapshot.executions) await this.execution?.restoreSuiteUpdate(origin, execution)
    // A configuration the update added has no snapshot; finalize keeps only the restored owners.
    await this.execution?.finalizeSuiteExecutions(origin, snapshot.executions.map(row => ({ owner: row.owner, variables: row.variables.map(next => next.name) })))
  }
  /** The committed version records its remaining cleanup so a restart can finish it. */
  settlement(entry: SuiteCatalogEntry, record: SuiteInstallRecord): NonNullable<SuiteInstallRecord['settling']> {
    return this.executionItems(entry).filter(item => !record.detached?.some(row => (row.kind === 'execution' || row.kind === 'skill') && row.name === item.skill))
      .map(item => ({ owner: suiteExecutionOwner(item.skill), variables: item.variables.map(row => row.name) }))
  }
  async settle(id: string, keep: NonNullable<SuiteInstallRecord['settling']>): Promise<void> {
    await this.execution?.finalizeSuiteExecutions(suiteInstallOrigin(id), keep)
  }
  private tool(entry: SuiteCatalogEntry): SuiteCatalogRuntimeDependencyItem | undefined { return entry.items.find((item): item is SuiteCatalogRuntimeDependencyItem => item.kind === 'runtime-dependency') }
  private skillItems(entry: SuiteCatalogEntry): readonly SuiteCatalogSkillItem[] { return entry.items.filter((item): item is SuiteCatalogSkillItem => item.kind === 'skill') }
  private packItem(entry: SuiteCatalogEntry): SuiteCatalogSkillPackItem | undefined { return entry.items.find((item): item is SuiteCatalogSkillPackItem => item.kind === 'skill-pack') }
  private executionItems(entry: SuiteCatalogEntry): readonly SuiteCatalogExecutionItem[] { return entry.items.filter((item): item is SuiteCatalogExecutionItem => item.kind === 'execution') }
}
