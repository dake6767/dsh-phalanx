import type { SuiteReplacedEntry } from '../domain/suite-catalog.js'
import { SuiteAvailability } from './suite-availability.js'
import { suiteInstallView, suiteCatalogView, busySuiteDependents } from './suite-catalog-state.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type {
  CommunitySuiteCatalogView,
  CommunitySuiteInstallPreview,
  CommunitySuiteUninstallPreview,
  CommunitySuiteUpdatePreview,
  CommunitySuiteInstallView,
} from '../domain/admin-contract.js'
import type { SuiteCatalogArchitecture, SuiteCatalogEntry, SuiteCatalogItem, SuiteCatalogItemKind, SuiteCatalogExecutionItem } from '../domain/suite-catalog.js'
import {
  suiteOwnedReferences,
  suiteExecutionOwner,
  suiteInstallOrigin,
  suiteExpertTargets,
  type SuiteInstalledEntry,
  type SuiteInstallRecord,
  type SuiteInstallState,
} from '../domain/suite-install.js'
import type { CatalogInstallRows, CatalogInstallRow } from '../ports/catalog-records.js'
import type { ExpertReferencesPort } from '../ports/experts.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import {
  ExecutionSuiteKind,
  PluginSuiteKind,
  RuntimeDependencySuiteKind,
  SkillPackSuiteKind,
  SkillSuiteKind,
  type SkillSuitePort,
  type SkillPackSuitePort,
  type ExecutionSuitePort,
  type PluginSuitePort,
  type SkillSuiteUpdatePort,
  type SkillPackSuiteUpdatePort,
  type ExecutionSuiteUpdatePort,
  type PluginSuiteUpdatePort,
  type SuiteItemOperations,
} from './suite-entry-kinds.js'
import { planReplacements, replacementBusy, replacementEntries, type SuiteReplacements } from './suite-replacements.js'
import { suiteUpdateContext, SuiteUpdates } from './suite-updates.js'
import type { SuiteCatalogGallery } from './suite-catalog-gallery.js'

/** Reads live installation and capability rows; it owns no task, snapshot or write lifecycle. */
export class SuiteCatalogQueries {
  readonly availability: SuiteAvailability
  private readonly kinds: Readonly<Record<SuiteCatalogItemKind, SuiteItemOperations<SuiteCatalogItem>>>
  private readonly updates: SuiteUpdates
  constructor(
    private readonly gallery: Pick<SuiteCatalogGallery, 'entries' | 'source' | 'load'>,
    private readonly installs: CatalogInstallRows,
    private readonly references: ExpertReferencesPort,
    private readonly dependencies: RuntimeDependencies,
    architecture: SuiteCatalogArchitecture,
    private readonly skills: SkillSuitePort & SkillSuiteUpdatePort,
    private readonly packs: SkillPackSuitePort & SkillPackSuiteUpdatePort,
    private readonly execution?: ExecutionSuitePort & ExecutionSuiteUpdatePort,
    private readonly plugins?: PluginSuitePort & PluginSuiteUpdatePort,
    private readonly held: () => readonly SuiteReplacedEntry[] = () => [],
  ) {
    this.kinds = {
      'runtime-dependency': new RuntimeDependencySuiteKind(dependencies, () => architecture),
      skill: new SkillSuiteKind(packs),
      'skill-pack': new SkillPackSuiteKind(),
      execution: new ExecutionSuiteKind(execution),
      plugin: new PluginSuiteKind(plugins),
    } as Readonly<Record<SuiteCatalogItemKind, SuiteItemOperations<SuiteCatalogItem>>>
    this.availability = new SuiteAvailability(
      () => this.entries(),
      async () => (await this.state()).installs,
      dependencies,
      item => this.operationsFor(item.kind).available(item),
    )
    this.updates = new SuiteUpdates(dependencies, architecture, skills, packs, execution, plugins)
  }
  async state(): Promise<SuiteInstallState> {
    return { installs: (await this.installs.list()).map(row => row.record) }
  }
  async installed(id: string): Promise<CatalogInstallRow> {
    const row = await this.installs.get(id)
    if (!row) throw new BusinessRuleError('missing', 'This catalog entry is not installed.', 'suite-not-installed')
    if (!['installed', 'failed'].includes(row.record.status))
      throw new BusinessRuleError('conflict', 'A task is already running for this entry.', 'suite-task-running')
    return row
  }
  async catalog(): Promise<CommunitySuiteCatalogView> {
    return suiteCatalogView(this.entries(), await this.state(), this.gallery.source(), this.execution, entry => this.availability.reason(entry))
  }
  /** Fetches the online catalog for one gallery view; the route awaits this before reading entries. */

  async installPreview(id: string): Promise<CommunitySuiteInstallPreview> {
    const entry = this.require(id),
      record = (await this.state()).installs.find(row => row.id === id)
    const shared = await this.availability.plan(entry)
    const available = await this.availability.available(entry, shared)
    const conflicts = await this.skills.suiteSkillConflicts(
      suiteInstallOrigin(id),
      entry.items.flatMap(item => (item.kind === 'skill' ? item.names : [])),
    )
    const commandConflicts = await this.commandConflicts(entry)
    const plan = await this.replacements(entry),
      packConflicts = await this.packConflicts(entry)
    const skillConflicts = conflicts.filter(name => !plan.skills.some(row => row.name === name))
    const dependencyConflicts = [
      ...new Set([...plan.conflicts.filter(name => !entry.items.some(item => item.kind === 'plugin' && item.packageName === name)), ...shared.conflicts]),
    ]
    const pluginConflicts = plan.conflicts.filter(name => entry.items.some(item => item.kind === 'plugin' && item.packageName === name))
    const reason =
      record?.status === 'installed'
        ? ('already-installed' as const)
        : (record && record.status !== 'failed') || shared.busy || replacementBusy(plan, this.held())
          ? ('task-running' as const)
          : shared.missing.length
            ? ('dependency-missing' as const)
            : (entry.unavailableReason ??
              (!available ? ('unavailable-architecture' as const) : undefined) ??
              (skillConflicts.length
                ? ('skill-conflicts' as const)
                : pluginConflicts.length
                  ? ('plugin-conflicts' as const)
                  : dependencyConflicts.length
                    ? ('dependency-conflicts' as const)
                    : packConflicts.length
                      ? ('pack-conflicts' as const)
                      : commandConflicts.length
                        ? ('command-conflicts' as const)
                        : undefined))
    const creates =
      reason === undefined
        ? entry.items.map(item => {
            const plan = this.operationsFor(item.kind).plan(item)
            return { kind: item.kind, name: plan.name, ...(plan.commands ? { commands: plan.commands } : {}), ...(plan.detail ? { detail: plan.detail } : {}) }
          })
        : []
    const dependencies = [
      ...shared.install.map(row => ({ id: row.entry.id, action: 'install' as const })),
      ...shared.reuse.map(id => ({ id, action: 'reuse' as const })),
      ...shared.manual.map(row => ({ id: row.id, action: 'manual' as const, name: row.name })),
    ]
    const replacements = replacementEntries(plan)
    return {
      id,
      version: entry.version,
      available,
      ...(reason ? { reason } : {}),
      creates,
      ...(skillConflicts.length ? { conflicts: skillConflicts } : {}),
      ...(commandConflicts.length ? { commandConflicts } : {}),
      ...(shared.missing.length ? { missingDependencies: shared.missing } : {}),
      ...(dependencies.length ? { dependencies } : {}),
      ...(replacements.length ? { replacements } : {}),
      ...(dependencyConflicts.length ? { dependencyConflicts } : {}),
      ...(packConflicts.length ? { packConflicts } : {}),
      ...(pluginConflicts.length ? { pluginConflicts } : {}),
    }
  }

  async uninstallPreview(id: string): Promise<CommunitySuiteUninstallPreview> {
    const { record } = await this.installed(id)
    const blocked = (await this.blockedReferences(record)).map(block => ({ name: block.owner, references: block.references }))
    const impact = (
      await Promise.all(
        record.entries.map(async entry => {
          const pack = entry.kind === 'skill-pack' ? await this.packs.suiteImpact(entry.name) : undefined
          const plugin = entry.kind === 'plugin' && this.plugins ? await this.plugins.suitePluginImpact(suiteInstallOrigin(id)) : undefined
          return pack ? [{ name: entry.name, ...pack }] : plugin ? [plugin] : []
        }),
      )
    ).flat()
    const experts = await this.references.impact(suiteExpertTargets(record))
    return {
      id,
      removes: record.entries,
      blocked,
      impact,
      dependencies: await this.dependenciesAfterUninstall(record),
      experts: experts.experts,
      expertRevision: experts.revision,
    }
  }

  async updatePreview(id: string): Promise<CommunitySuiteUpdatePreview> {
    const record = (await this.state()).installs.find(row => row.id === id),
      entry = this.require(id)
    if (!record || record.status === 'failed')
      return {
        id,
        from: record?.version ?? '',
        to: entry.version,
        reason: 'not-installed',
        skills: { added: [], removed: [], updated: [] },
        dependents: [],
        skipped: [],
        manualDependencies: [],
      }
    if (entry.unavailableReason)
      return {
        id,
        from: record.version,
        to: entry.version,
        reason: entry.unavailableReason,
        skills: { added: [], removed: [], updated: [] },
        dependents: [],
        skipped: [],
        manualDependencies: [],
      }
    const preview = await this.updates.preview(suiteUpdateContext(record, entry, await this.state()))
    return record.status === 'installed' && !(await this.busyDependents(id)).length ? preview : { ...preview, reason: 'task-running' }
  }
  /** Platform upgrades only offer updates; the installed version keeps running until this task switched every step. */

  async blockedReferences(
    record: SuiteInstallRecord,
    leaving?: SuiteInstallRecord,
  ): Promise<readonly { owner: string; references: readonly { kind: string; name: string }[] }[]> {
    const owned = new Set([...suiteOwnedReferences(record), ...(leaving ? suiteOwnedReferences(leaving) : [])])
    const blocking: { owner: string; references: { kind: string; name: string }[] }[] = []
    for (const entry of record.entries) {
      const references = (await this.operationsFor(entry.kind).references(entry)).filter(reference => !owned.has(`${reference.kind}:${reference.name}`))
      if (references.length) blocking.push({ owner: entry.name, references })
    }
    const suites = (await this.state()).installs.filter(
      row => row.id !== leaving?.id && row.id !== record.id && row.status !== 'failed' && row.dependencies?.includes(record.id),
    )
    if (suites.length) blocking.push({ owner: record.id, references: suites.map(row => ({ kind: 'suite', name: row.id })) })
    return blocking
  }
  /** Removes every library row this install owns: pack, delegated execution, skills, then the runtime dependency. */

  entries(): readonly SuiteCatalogEntry[] {
    return this.gallery.entries()
  }

  async packConflicts(entry: SuiteCatalogEntry): Promise<readonly string[]> {
    return this.packs.suitePackConflicts(
      suiteInstallOrigin(entry.id),
      entry.items.flatMap(item => (item.kind === 'skill-pack' ? [item.name] : [])),
    )
  }

  async replacements(entry: SuiteCatalogEntry): Promise<SuiteReplacements> {
    return await planReplacements(entry, suiteInstallOrigin(entry.id), this.dependencies, this.skills, this.plugins)
  }
  /** Originals of every row the install will take over, captured before the task starts. */

  async dependenciesAfterUninstall(record: SuiteInstallRecord): Promise<readonly { id: string; references: readonly { kind: string; name: string }[] }[]> {
    return (
      await Promise.all(
        (record.dependencies ?? []).map(async id => {
          const shared = (await this.state()).installs.find(row => row.id === id && row.status === 'installed')
          return shared ? [{ id, references: (await this.blockedReferences(shared, record)).flatMap(block => block.references) }] : []
        }),
      )
    ).flat()
  }
  /** Suites that declare this catalog dependency and are installing or uninstalling right now. */

  async busyDependents(id: string): Promise<readonly string[]> {
    return busySuiteDependents((await this.state()).installs, id)
  }
  /** Removes a shared dependency record that a failed task added, or restores the one it replaced. */

  operationsFor(kind: SuiteCatalogItemKind | SuiteInstalledEntry['kind']): SuiteItemOperations<SuiteCatalogItem> {
    if (kind in this.kinds) return this.kinds[kind as SuiteCatalogItemKind]
    throw new BusinessRuleError('invalid', 'Unsupported suite entry kind.', 'suite-catalog-invalid')
  }

  async commandConflicts(entry: SuiteCatalogEntry): Promise<readonly string[]> {
    const replacing = (await this.replacements(entry)).skills.map(row => suiteExecutionOwner(row.name))
    return (
      await Promise.all(
        this.executionItems(entry).map(
          item =>
            this.execution?.delegatedCommandConflicts(
              suiteExecutionOwner(item.skill),
              item.delegated.map(row => row.command),
              replacing,
            ) ?? Promise.resolve([]),
        ),
      )
    ).flat()
  }

  executionItems(entry: SuiteCatalogEntry): readonly SuiteCatalogExecutionItem[] {
    return entry.items.filter((item): item is SuiteCatalogExecutionItem => item.kind === 'execution')
  }

  require(id: string): SuiteCatalogEntry {
    const entry = this.entries().find(row => row.id === id)
    if (!entry) throw new BusinessRuleError('missing', 'This catalog entry does not exist.', 'suite-not-found')
    return entry
  }

  view(row: SuiteInstallRecord): Promise<CommunitySuiteInstallView> {
    return suiteInstallView(row, this.gallery.entries(), this.execution)
  }
}
