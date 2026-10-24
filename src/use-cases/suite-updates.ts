import { pluginAccessIdentity } from '../domain/plugin-access.js'
import type { SuiteCatalogPluginItem } from '../domain/suite-catalog.js'
import type { PluginSuiteUpdatePort } from './suite-entry-kinds.js'
import { resolvedPluginItem } from './suite-entry-kinds.js'
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
    private readonly skills: SkillSuiteUpdatePort, private readonly packs: SkillPackSuiteUpdatePort, private readonly execution?: ExecutionSuiteUpdatePort, private readonly plugins?: PluginSuiteUpdatePort) {}

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
      changed: nextCommands.filter(row => { const old = oldCommands.find(next => next.command === row.command); return old && (old.blocked.join(' ') !== row.blocked.join(' ') || (old.blockedOptions ?? []).join(' ') !== (row.blockedOptions ?? []).join(' ') || old.source !== row.source || old.memberPath !== row.memberPath) }).map(row => row.command) }
    const variables = { added: nextVariables.filter(row => !oldVariables.some(old => old.name === row.name && Boolean(oldExecution.find(item => item.variables.some(variable => variable.name === old.name))?.optionalVariables?.includes(old.name)) === Boolean(row.optional))).map(row => row.name),
      removed: oldVariables.filter(row => !nextVariables.some(next => next.name === row.name)).map(row => row.name) }
    // A skill the new version adds may meanwhile exist in the library under another origin.
    const conflicts = this.skills.suiteSkillConflicts(origin, names)
    const missing = entry.category !== 'dependency' ? entry.dependencies.filter(id => context.catalogDependencyName(id) === undefined) : []
    const reason = compareSuiteVersions(entry.version, record.version) <= 0 ? 'up-to-date' : (entry.items.some(item => item.kind === 'runtime-dependency' && !suiteRuntimeDependencyDefinition(item, this.architecture))) ? 'unavailable-architecture'
      : conflicts.length ? 'skill-conflicts' : missing.length ? 'dependency-missing' : undefined
    const plugin = this.pluginPreview(context), dependencyChanges = entry.category === 'plugin' ? this.pluginDependencyPreview(context) : undefined
    return { ...(dependencyChanges ? { dependencyChanges } : {}), ...(plugin ? { plugin } : {}), id: entry.id, from: record.version, to: entry.version, ...(reason ? { reason } : {}),
      ...(entry.category !== 'plugin' && tool && installedTool && !skip('runtime-dependency', installedTool.name) ? { dependency: { name: installedTool.name, changed: !current || definition?.prepareCommand !== current.prepareCommand || definition.checkCommand !== current.checkCommand || definition.pathDirectories.join('\0') !== current.pathDirectories.join('\0') } } : {}),
      skills: { added: names.filter(name => !oldSkills.some(row => row.name === name)), removed: oldSkills.map(row => row.name).filter(name => !names.includes(name)),
        updated: oldSkills.filter(row => names.includes(row.name) && row.source?.commit !== commitOf(row.name)).map(row => row.name) },
      ...(pack && installedPack && !skip('skill-pack', installedPack.name) ? { pack: { name: pack.name, added: pack.skills.filter(name => !installedPack.skills.includes(name) && !skip('skill', name)), removed: installedPack.skills.filter(name => !pack.skills.includes(name) && !skip('skill', name)) } } : {}),
      ...(newExecution.length || oldExecution.length ? { execution: { commands, variables } } : {}),
      dependents: entry.category === 'dependency' ? context.installs.filter(row => row.dependencies?.includes(entry.id)).map(row => row.id) : [],
      skipped: detached, manualDependencies: record.manualDependencies ?? [],
      ...(conflicts.length ? { conflicts } : {}), ...(missing.length ? { missingDependencies: missing } : {}) }
  }
  dependencyNames(id: string): Readonly<Record<string, string>> { return Object.fromEntries(this.dependencies.managedRows(suiteInstallOrigin(id)).map(row => [row.managedItem ?? row.name, row.name])) }
  /** Captures every row the update may change, before the task starts. */
  snapshot(record: SuiteInstallRecord): SuiteUpdateSnapshot {
    const origin = suiteInstallOrigin(record.id), pack = this.packs.suitePack(origin), plugin = this.plugins?.suitePluginRow(origin)
    const executions = record.entries.flatMap(row => { const snapshot = row.kind === 'execution' ? this.execution?.suiteOwnedSnapshot(origin, suiteExecutionOwner(row.name)) : undefined; return snapshot ? [snapshot] : [] })
    return { version: record.version, ...(record.contentHash ? { contentHash: record.contentHash } : {}), entries: record.entries, ...(record.dependencies ? { dependencies: record.dependencies } : {}), dependencyRows: this.dependencies.managedRows(origin),
      skills: this.skills.suiteSkills(origin), ...(pack ? { pack } : {}), ...(plugin ? { plugin: { row: plugin } } : {}), executions }
  }
  /** Prepares everything first, then switches; returns the entries now installed. Throws with the old rows untouched before the switch. */
  async run(context: SuiteUpdateContext, log: (line: string) => Promise<void>, checkpoint: (assignments: SuiteSkillAssignments) => void): Promise<readonly SuiteInstalledEntry[]> {
    if (context.entry.category === 'plugin') return this.runPlugin(context, log)
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
        const owner = suiteExecutionOwner(item.skill), template = { commands: item.delegated, variables: item.variables.map(row => row.name), optionalVariables: item.variables.filter(row => row.optional).map(row => row.name), runtimeDependencies: [dependencyName(item.runtimeDependency)] }
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
    if (snapshot.plugin) await this.plugins?.restoreSuitePlugin(origin, snapshot.plugin)
    for (const row of snapshot.dependencyRows) this.dependencies.restoreManaged(origin, row)
    if (snapshot.plugin) await this.dependencies.removeManaged(origin, snapshot.dependencyRows.map(row => row.name))
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
    await this.plugins?.settleSuitePlugin?.(suiteInstallOrigin(id))
    await this.execution?.finalizeSuiteExecutions(suiteInstallOrigin(id), keep)
  }
  private pluginPreview(context: SuiteUpdateContext): CommunitySuiteUpdatePreview['plugin'] {
    const origin = suiteInstallOrigin(context.entry.id), row = this.plugins?.suitePluginRow(origin)
    const declaration = context.entry.items.find((next): next is SuiteCatalogPluginItem => next.kind === 'plugin')
    const dependencies = this.dependencies.managedRows(origin)
    const item = declaration ? resolvedPluginItem(declaration, [...declaration.runtimeDependencies.map(name => context.record.dependencyNames?.[name] ?? dependencies.find(row => (row.managedItem ?? row.name) === name)?.name ?? name), ...declaration.catalogDependencies.map(id => context.catalogDependencyName(id) ?? id)]) : undefined
    if (!row || !item || context.record.detached?.some(next => next.kind === 'plugin')) return undefined
    const settings = this.plugins?.suitePluginAccess(origin), current = settings ?? { environment: [], entriesYaml: '' }
    const next = item.access.environment, old = current.environment
    return { packageName: item.packageName, from: row.version, to: item.version, modified: row.suiteAppliedAccess !== pluginAccessIdentity(current),
      access: { entriesChanged: item.access.entriesYaml !== current.entriesYaml,
        added: next.filter(value => !old.some(before => before.name === value.name)), removed: old.filter(value => !next.some(after => after.name === value.name)),
        changed: next.flatMap(value => { const before = old.find(old => old.name === value.name); return before && before.value !== value.value ? [{ name: value.name, from: before.value, to: value.value }] : [] }) } }
  }
  private pluginDependencyPreview(context: SuiteUpdateContext): NonNullable<CommunitySuiteUpdatePreview['dependencyChanges']> {
    const { entry, record } = context, rows = this.dependencies.managedRows(suiteInstallOrigin(entry.id))
    const tools = entry.items.filter((row): row is SuiteCatalogRuntimeDependencyItem => row.kind === 'runtime-dependency')
    const changes = tools.flatMap(tool => {
      const name = record.dependencyNames?.[tool.name] ?? rows.find(row => (row.managedItem ?? row.name) === tool.name)?.name ?? tool.name
      if (record.detached?.some(row => row.kind === 'runtime-dependency' && row.name === name)) return []
      const before = rows.find(row => row.name === name), next = suiteRuntimeDependencyDefinition(tool, this.architecture)
      const changed = !before || !next || JSON.stringify([before.prepareCommand, before.pathDirectories, before.checkCommand]) !== JSON.stringify([next.prepareCommand, next.pathDirectories, next.checkCommand])
      return [{ name, from: before ? record.version : '', to: entry.version, changed }]
    })
    return [...changes, ...rows.filter(row => !tools.some(tool => (record.dependencyNames?.[tool.name] ?? tool.name) === row.name || tool.name === row.managedItem)).map(row => ({ name: row.name, from: record.version, to: '', changed: true }))]
  }
  private async runPlugin(context: SuiteUpdateContext, log: (line: string) => Promise<void>): Promise<readonly SuiteInstalledEntry[]> {
    const { entry, record } = context, origin = suiteInstallOrigin(entry.id)
    if (!this.plugins) throw new BusinessRuleError('invalid', 'Plugin updates are unavailable.', 'suite-catalog-invalid')
    const item = entry.items.find((row): row is SuiteCatalogPluginItem => row.kind === 'plugin')
    if (!item || record.detached?.some(row => row.kind === 'plugin')) return record.entries
    const plugin = this.plugins.suitePluginRow(origin)
    if (!plugin || item.packageName !== plugin.packageName) throw new BusinessRuleError('conflict', 'Plugin identity changed.', 'plugin-name-in-use')
    const tools = entry.items.filter((row): row is SuiteCatalogRuntimeDependencyItem => row.kind === 'runtime-dependency')
    const actualName = (name: string) => record.dependencyNames?.[name] ?? rows.find(row => (row.managedItem ?? row.name) === name)?.name ?? name
    const detachedDependency = (name: string) => record.detached?.some(row => row.kind === 'runtime-dependency' && row.name === actualName(name))
    const rows = this.dependencies.managedRows(origin)
    const staged: { definition: NonNullable<ReturnType<typeof suiteRuntimeDependencyDefinition>>, version: Awaited<ReturnType<RuntimeDependencies['stageManaged']>> }[] = []
    for (const tool of tools) {
      if (detachedDependency(tool.name)) continue
      const definition = suiteRuntimeDependencyDefinition(tool, this.architecture)
      if (!definition) throw new BusinessRuleError('invalid', 'This architecture is unavailable.', 'suite-arch-unavailable')
      const current = rows.find(row => row.name === actualName(tool.name))
      if (!current || JSON.stringify([definition.prepareCommand, definition.pathDirectories, definition.checkCommand]) !== JSON.stringify([current.prepareCommand, current.pathDirectories, current.checkCommand]))
        staged.push({ definition: { ...definition, name: current?.name ?? tool.name }, version: await this.dependencies.stageManaged(definition, async () => {}, this.signal()) })
    }
    const prepared = await this.plugins.prepareSuitePlugin(origin, item, log, this.signal())
    try {
      const namesByItem = new Map([...Object.entries(record.dependencyNames ?? {}), ...rows.map(row => [row.managedItem ?? row.name, row.name] as const)])
      for (const value of staged) {
        const current = rows.find(row => row.name === value.definition.name)
        if (current) this.dependencies.updateManaged(origin, current.name, value.definition, value.version)
        else namesByItem.set(value.definition.name, this.dependencies.commitManaged(origin, value.definition, value.version))
      }
      const names = [...item.runtimeDependencies.map(name => namesByItem.get(name) ?? name), ...item.catalogDependencies.map(id => context.catalogDependencyName(id)!)]
      await this.plugins.updateSuitePlugin(origin, resolvedPluginItem(item, names), prepared, names)
      const retained = tools.filter(tool => !detachedDependency(tool.name)).map(tool => namesByItem.get(tool.name) ?? tool.name)
      await this.dependencies.removeManaged(origin, retained)
      return [{ kind: 'plugin', name: item.packageName }, ...retained.map(name => ({ kind: 'runtime-dependency' as const, name }))]
    } finally { await this.plugins.discardSuitePlugin(origin) }
  }
  private tool(entry: SuiteCatalogEntry): SuiteCatalogRuntimeDependencyItem | undefined { return entry.items.find((item): item is SuiteCatalogRuntimeDependencyItem => item.kind === 'runtime-dependency') }
  private skillItems(entry: SuiteCatalogEntry): readonly SuiteCatalogSkillItem[] { return entry.items.filter((item): item is SuiteCatalogSkillItem => item.kind === 'skill') }
  private packItem(entry: SuiteCatalogEntry): SuiteCatalogSkillPackItem | undefined { return entry.items.find((item): item is SuiteCatalogSkillPackItem => item.kind === 'skill-pack') }
  private executionItems(entry: SuiteCatalogEntry): readonly SuiteCatalogExecutionItem[] { return entry.items.filter((item): item is SuiteCatalogExecutionItem => item.kind === 'execution') }
}

/** Resolves an installed entry's shared dependencies without consulting the online catalog. */
export function suiteUpdateContext(record: SuiteInstallRecord, entry: SuiteCatalogEntry, state: import('../domain/suite-install.js').SuiteInstallState): SuiteUpdateContext {
    const installs = state.installs
    return { record, entry, installs, catalogDependencyName: id => {
      const manual = record.manualDependencies?.find(row => row.id === id)
      if (manual) return manual.name
      const shared = installs.find(row => row.id === id && row.status === 'installed')
      return shared?.entries.find(row => row.kind === 'runtime-dependency')?.name
    } }
}
