import { pluginAccessIdentity } from '../domain/plugin-access.js'
import type { SuiteCatalogPluginItem } from '../domain/suite-catalog.js'
import type { PluginSuiteUpdatePort } from './suite-entry-kinds.js'
import { resolvedPluginItem } from './suite-entry-kinds.js'
import type { CommunitySuiteUpdatePreview } from '../domain/admin-contract.js'
import {
  suiteRuntimeDependencyDefinition,
  type SuiteCatalogArchitecture,
  type SuiteCatalogEntry,
  type SuiteCatalogExecutionItem,
  type SuiteCatalogRuntimeDependencyItem,
  type SuiteCatalogSkillItem,
  type SuiteCatalogSkillPackItem,
} from '../domain/suite-catalog.js'
import { compareSuiteVersions, suiteExecutionOwner, suiteInstallOrigin, type SuiteInstalledEntry, type SuiteInstallRecord } from '../domain/suite-install.js'
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
  constructor(
    private readonly dependencies: RuntimeDependencies,
    private readonly architecture: SuiteCatalogArchitecture,
    private readonly skills: SkillSuiteUpdatePort,
    private readonly packs: SkillPackSuiteUpdatePort,
    private readonly execution?: ExecutionSuiteUpdatePort,
    private readonly plugins?: PluginSuiteUpdatePort,
  ) {}

  async preview(context: SuiteUpdateContext): Promise<CommunitySuiteUpdatePreview> {
    const { record, entry } = context,
      origin = suiteInstallOrigin(entry.id),
      detached = record.detached ?? []
    const skip = (kind: SuiteInstalledEntry['kind'], name: string) => detached.some(row => row.kind === kind && row.name === name)
    const tool = this.tool(entry),
      installedTool = record.entries.find(row => row.kind === 'runtime-dependency')
    const current = installedTool ? (await this.dependencies.managedRows(origin)).find(row => row.name === installedTool.name) : undefined
    const definition = tool ? suiteRuntimeDependencyDefinition(tool, this.architecture) : undefined
    const oldSkills = await this.skills.suiteSkills(origin),
      names = this.skillItems(entry)
        .flatMap(item => item.names)
        .filter(name => !skip('skill', name))
    const commitOf = (name: string) => this.skillItems(entry).find(item => item.names.includes(name))?.source.commit
    const pack = this.packItem(entry),
      installedPack = await this.packs.suitePack(origin)
    const oldExecution = (
      await Promise.all(
        record.entries.map(row => (row.kind === 'execution' ? this.execution?.suiteOwnedSnapshot(origin, suiteExecutionOwner(row.name)) : undefined)),
      )
    ).flatMap(row => (row ? [row] : []))
    const newExecution = this.executionItems(entry).filter(item => !skip('execution', item.skill) && !skip('skill', item.skill))
    const oldCommands = oldExecution.flatMap(item => item.commands),
      nextCommands = newExecution.flatMap(item => item.delegated)
    const oldVariables = oldExecution.flatMap(item => item.variables),
      nextVariables = newExecution.flatMap(item => item.variables)
    const commands = {
      added: nextCommands.filter(row => !oldCommands.some(old => old.command === row.command)).map(row => row.command),
      removed: oldCommands.filter(row => !nextCommands.some(next => next.command === row.command)).map(row => row.command),
      changed: nextCommands
        .filter(row => {
          const old = oldCommands.find(next => next.command === row.command)
          return (
            old &&
            (old.blocked.join(' ') !== row.blocked.join(' ') ||
              (old.blockedOptions ?? []).join(' ') !== (row.blockedOptions ?? []).join(' ') ||
              old.source !== row.source ||
              old.memberPath !== row.memberPath)
          )
        })
        .map(row => row.command),
    }
    const variables = {
      added: nextVariables
        .filter(
          row =>
            !oldVariables.some(
              old =>
                old.name === row.name &&
                Boolean(oldExecution.find(item => item.variables.some(variable => variable.name === old.name))?.optionalVariables?.includes(old.name)) ===
                  Boolean(row.optional),
            ),
        )
        .map(row => row.name),
      removed: oldVariables.filter(row => !nextVariables.some(next => next.name === row.name)).map(row => row.name),
    }
    // A skill the new version adds may meanwhile exist in the library under another origin.
    const conflicts = await this.skills.suiteSkillConflicts(origin, names)
    const missing = entry.category !== 'dependency' ? entry.dependencies.filter(id => context.catalogDependencyName(id) === undefined) : []
    const reason =
      compareSuiteVersions(entry.version, record.version) <= 0
        ? 'up-to-date'
        : entry.items.some(item => item.kind === 'runtime-dependency' && !suiteRuntimeDependencyDefinition(item, this.architecture))
          ? 'unavailable-architecture'
          : conflicts.length
            ? 'skill-conflicts'
            : missing.length
              ? 'dependency-missing'
              : undefined
    const plugin = await this.pluginPreview(context),
      dependencyChanges = entry.category === 'plugin' ? await this.pluginDependencyPreview(context) : undefined
    return {
      ...(dependencyChanges ? { dependencyChanges } : {}),
      ...(plugin ? { plugin } : {}),
      id: entry.id,
      from: record.version,
      to: entry.version,
      ...(reason ? { reason } : {}),
      ...(entry.category !== 'plugin' && tool && installedTool && !skip('runtime-dependency', installedTool.name)
        ? {
            dependency: {
              name: installedTool.name,
              changed:
                !current ||
                definition?.prepareCommand !== current.prepareCommand ||
                definition.checkCommand !== current.checkCommand ||
                definition.pathDirectories.join('\0') !== current.pathDirectories.join('\0'),
            },
          }
        : {}),
      skills: {
        added: names.filter(name => !oldSkills.some(row => row.name === name)),
        removed: oldSkills.map(row => row.name).filter(name => !names.includes(name)),
        updated: oldSkills.filter(row => names.includes(row.name) && row.source?.commit !== commitOf(row.name)).map(row => row.name),
      },
      ...(pack && installedPack && !skip('skill-pack', installedPack.name)
        ? {
            pack: {
              name: pack.name,
              added: pack.skills.filter(name => !installedPack.skills.includes(name) && !skip('skill', name)),
              removed: installedPack.skills.filter(name => !pack.skills.includes(name) && !skip('skill', name)),
            },
          }
        : {}),
      ...(newExecution.length || oldExecution.length ? { execution: { commands, variables } } : {}),
      dependents: entry.category === 'dependency' ? context.installs.filter(row => row.dependencies?.includes(entry.id)).map(row => row.id) : [],
      skipped: detached,
      manualDependencies: record.manualDependencies ?? [],
      ...(conflicts.length ? { conflicts } : {}),
      ...(missing.length ? { missingDependencies: missing } : {}),
    }
  }
  private async pluginPreview(context: SuiteUpdateContext): Promise<CommunitySuiteUpdatePreview['plugin']> {
    const origin = suiteInstallOrigin(context.entry.id),
      row = await this.plugins?.suitePluginRow(origin)
    const declaration = context.entry.items.find((next): next is SuiteCatalogPluginItem => next.kind === 'plugin')
    const dependencies = await this.dependencies.managedRows(origin)
    const item = declaration
      ? resolvedPluginItem(declaration, [
          ...declaration.runtimeDependencies.map(
            name => context.record.dependencyNames?.[name] ?? dependencies.find(row => (row.managedItem ?? row.name) === name)?.name ?? name,
          ),
          ...declaration.catalogDependencies.map(id => context.catalogDependencyName(id) ?? id),
        ])
      : undefined
    if (!row || !item || context.record.detached?.some(next => next.kind === 'plugin')) return undefined
    const settings = await this.plugins?.suitePluginAccess(origin),
      current = settings ?? { environment: [], entriesYaml: '' }
    const next = item.access.environment,
      old = current.environment
    return {
      packageName: item.packageName,
      from: row.version,
      to: item.version,
      modified: row.suiteAppliedAccess !== pluginAccessIdentity(current),
      access: {
        entriesChanged: item.access.entriesYaml !== current.entriesYaml,
        added: next.filter(value => !old.some(before => before.name === value.name)),
        removed: old.filter(value => !next.some(after => after.name === value.name)),
        changed: next.flatMap(value => {
          const before = old.find(old => old.name === value.name)
          return before && before.value !== value.value ? [{ name: value.name, from: before.value, to: value.value }] : []
        }),
      },
    }
  }
  private async pluginDependencyPreview(context: SuiteUpdateContext): Promise<NonNullable<CommunitySuiteUpdatePreview['dependencyChanges']>> {
    const { entry, record } = context,
      rows = await this.dependencies.managedRows(suiteInstallOrigin(entry.id))
    const tools = entry.items.filter((row): row is SuiteCatalogRuntimeDependencyItem => row.kind === 'runtime-dependency')
    const changes = tools.flatMap(tool => {
      const name = record.dependencyNames?.[tool.name] ?? rows.find(row => (row.managedItem ?? row.name) === tool.name)?.name ?? tool.name
      if (record.detached?.some(row => row.kind === 'runtime-dependency' && row.name === name)) return []
      const before = rows.find(row => row.name === name),
        next = suiteRuntimeDependencyDefinition(tool, this.architecture)
      const changed =
        !before ||
        !next ||
        JSON.stringify([before.prepareCommand, before.pathDirectories, before.checkCommand]) !==
          JSON.stringify([next.prepareCommand, next.pathDirectories, next.checkCommand])
      return [{ name, from: before ? record.version : '', to: entry.version, changed }]
    })
    return [
      ...changes,
      ...rows
        .filter(row => !tools.some(tool => (record.dependencyNames?.[tool.name] ?? tool.name) === row.name || tool.name === row.managedItem))
        .map(row => ({ name: row.name, from: record.version, to: '', changed: true })),
    ]
  }
  private tool(entry: SuiteCatalogEntry): SuiteCatalogRuntimeDependencyItem | undefined {
    return entry.items.find((item): item is SuiteCatalogRuntimeDependencyItem => item.kind === 'runtime-dependency')
  }
  private skillItems(entry: SuiteCatalogEntry): readonly SuiteCatalogSkillItem[] {
    return entry.items.filter((item): item is SuiteCatalogSkillItem => item.kind === 'skill')
  }
  private packItem(entry: SuiteCatalogEntry): SuiteCatalogSkillPackItem | undefined {
    return entry.items.find((item): item is SuiteCatalogSkillPackItem => item.kind === 'skill-pack')
  }
  private executionItems(entry: SuiteCatalogEntry): readonly SuiteCatalogExecutionItem[] {
    return entry.items.filter((item): item is SuiteCatalogExecutionItem => item.kind === 'execution')
  }
}

/** Resolves an installed entry's shared dependencies without consulting the online catalog. */
export function suiteUpdateContext(
  record: SuiteInstallRecord,
  entry: SuiteCatalogEntry,
  state: import('../domain/suite-install.js').SuiteInstallState,
): SuiteUpdateContext {
  const installs = state.installs
  return {
    record,
    entry,
    installs,
    catalogDependencyName: id => {
      const manual = record.manualDependencies?.find(row => row.id === id)
      if (manual) return manual.name
      const shared = installs.find(row => row.id === id && row.status === 'installed')
      return shared?.entries.find(row => row.kind === 'runtime-dependency')?.name
    },
  }
}
