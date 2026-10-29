import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { RuntimeDependencyPreparationFailure, type RuntimeDependencyDefinition, type RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import { suiteRuntimeDependencyDefinition, type SuiteCatalogArchitecture, type SuiteCatalogEntry, type SuiteInstallRequest } from '../domain/suite-catalog.js'
import { suiteInstallOrigin, type SuiteInstalledEntry } from '../domain/suite-install.js'
import type { CatalogInstallRow, CatalogRequestRow } from '../ports/catalog-records.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import type { SkillLibrary } from './skill-library.js'
import type { SuitePlugins } from './suite-plugins.js'
import type { SuiteReplacementPlan } from './suite-entry-kinds.js'
import type { PreparedSuitePlugin } from './suite-plugin-facts.js'
import type { PreparedSuiteInstall, SuiteTransactions } from './suite-transactions.js'

interface ChangeUnit {
  readonly installed: CatalogInstallRow
  readonly entry: SuiteCatalogEntry
  readonly replacement?: SuiteReplacementPlan
}

/** Owns external preparation leases until the single fact transaction has committed or rejected. */
export class SuiteChanges {
  constructor(
    private readonly transactions: Pick<SuiteTransactions, 'install' | 'update'>,
    private readonly dependencies: Pick<RuntimeDependencies, 'managedRows' | 'stageManaged' | 'withPreparedVersion'>,
    private readonly skills: Pick<SkillLibrary, 'prepareSuiteImport' | 'preparedSuiteImport' | 'withSuiteNotes' | 'discardSuiteImport'>,
    private readonly architecture: SuiteCatalogArchitecture,
    private readonly signal: () => AbortSignal,
    private readonly plugins?: Pick<SuitePlugins, 'prepareCatalogPlugin' | 'discardSuitePlugin'>,
  ) {}
  install(
    actor: CommunityAccountActor,
    units: readonly ChangeUnit[],
    options: SuiteInstallRequest,
    request: CatalogRequestRow,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const accepted = structuredClone({ actor, options, request })
    return this.prepare(units, false, log, plans => this.transactions.install(accepted.actor, plans, accepted.options, accepted.request))
  }
  update(actor: CommunityAccountActor, installed: CatalogInstallRow, entry: SuiteCatalogEntry, log: (line: string) => Promise<void>): Promise<void> {
    const accepted = structuredClone(actor)
    return this.prepare([{ installed, entry }], true, log, plans => this.transactions.update(accepted, plans[0]!))
  }
  private async prepare(
    input: readonly ChangeUnit[],
    updating: boolean,
    log: (line: string) => Promise<void>,
    commit: (plans: readonly PreparedSuiteInstall[]) => Promise<void>,
  ): Promise<void> {
    const units = structuredClone(input),
      stages: string[] = [],
      pluginOrigins: string[] = [],
      plans: PreparedSuiteInstall[] = []
    const nextUnit = async (index: number): Promise<void> => {
      const unit = units[index]
      if (!unit) {
        const notes = plans.flatMap(plan =>
          plan.entry.items.flatMap(item =>
            item.kind === 'skill-pack' && !plan.installed.record.detached?.some(row => row.kind === 'skill-pack' && row.name === item.name)
              ? [{ id: plan.entry.id, name: item.name, description: item.description, instructions: item.note }]
              : [],
          ),
        )
        return this.skills.withSuiteNotes(notes, async prepared => {
          this.signal().throwIfAborted()
          await commit(plans.map(plan => ({ ...plan, ...(prepared.get(plan.entry.id) ? { note: prepared.get(plan.entry.id)! } : {}) })))
        })
      }
      this.signal().throwIfAborted()
      const { entry, installed } = unit,
        origin = suiteInstallOrigin(entry.id),
        detached = updating ? (installed.record.detached ?? []) : [],
        skip = (kind: SuiteInstalledEntry['kind'], name: string) => detached.some(row => row.kind === kind && row.name === name),
        pluginDetached = entry.category === 'plugin' && detached.some(row => row.kind === 'plugin'),
        owned = updating ? await this.dependencies.managedRows(origin) : [],
        actualName = (name: string) => installed.record.dependencyNames?.[name] ?? owned.find(row => (row.managedItem ?? row.name) === name)?.name ?? name,
        runtime: { definition: RuntimeDependencyDefinition; version: RuntimeDependencyVersion }[] = [],
        skills: PreparedSuiteInstall['skills'][number][] = [],
        tools = entry.items.filter(item => item.kind === 'runtime-dependency' && !pluginDetached && !skip('runtime-dependency', actualName(item.name)))
      const nextRuntime = async (position: number): Promise<void> => {
        const item = tools[position]
        if (item?.kind === 'runtime-dependency') {
          const definition = suiteRuntimeDependencyDefinition(item, this.architecture)
          if (!definition) throw new BusinessRuleError('invalid', 'This architecture is unavailable.', 'suite-arch-unavailable')
          const current = owned.find(row => row.name === actualName(item.name))
          if (
            current?.current &&
            JSON.stringify([definition.prepareCommand, definition.pathDirectories, definition.checkCommand]) ===
              JSON.stringify([current.prepareCommand, current.pathDirectories, current.checkCommand])
          )
            return nextRuntime(position + 1)
          return this.dependencies.withPreparedVersion(
            async () => {
              await log(`Preparing runtime dependency ${definition.name}…`)
              this.signal().throwIfAborted()
              try {
                return await this.dependencies.stageManaged(definition, async () => {}, this.signal())
              } catch (error) {
                if (error instanceof RuntimeDependencyPreparationFailure) await log(error.log.trimEnd())
                throw error
              }
            },
            async version => {
              runtime.push({ definition, version })
              await nextRuntime(position + 1)
            },
          )
        }
        for (const [position, item] of entry.items.entries()) {
          if (item.kind !== 'skill' || pluginDetached) continue
          const names = item.names.filter(name => !skip('skill', name))
          if (!names.length) continue
          const stage = `${origin}:change:${position}`
          // Register before preparation so rejection also releases partially accepted staging.
          stages.push(stage)
          await log(`Importing skills from ${item.source.url} @ ${item.source.commit.slice(0, 7)}…`)
          await this.skills.prepareSuiteImport(
            origin,
            { url: item.source.url, subpath: item.source.path, ref: item.source.commit },
            names,
            log,
            this.signal(),
            unit.replacement?.skills.map(row => row.name) ?? [],
            stage,
          )
          skills.push({ item: { ...item, names }, rows: this.skills.preparedSuiteImport(stage) })
        }
        let plugin: PreparedSuitePlugin | undefined
        const pluginItem = entry.items.find(item => item.kind === 'plugin')
        if (pluginItem && !pluginDetached) {
          if (!this.plugins) throw new BusinessRuleError('invalid', 'Plugin preparation is unavailable.', 'suite-catalog-invalid')
          pluginOrigins.push(origin)
          plugin = await this.plugins.prepareCatalogPlugin(origin, pluginItem, log, this.signal(), unit.replacement?.plugins?.[0]?.revision)
        }
        plans.push({ ...unit, runtime, skills, ...(plugin ? { plugin } : {}) })
        await nextUnit(index + 1)
      }
      await nextRuntime(0)
    }
    try {
      await nextUnit(0)
    } finally {
      // Cleanup failure cannot change the committed business outcome or hide the original preparation error.
      for (const stage of stages) await this.skills.discardSuiteImport(stage).catch(() => console.warn('Catalog skill staging collection deferred.'))
      for (const origin of pluginOrigins)
        await this.plugins?.discardSuitePlugin(origin).catch(() => console.warn('Catalog plugin staging collection deferred.'))
    }
  }
}
