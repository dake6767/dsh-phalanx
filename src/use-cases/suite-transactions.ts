import { isDeepStrictEqual } from 'node:util'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { RuntimeDependencyDefinition, RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { SuiteCatalogEntry, SuiteCatalogSkillItem, SuiteCatalogExecutionItem, SuiteInstallRequest } from '../domain/suite-catalog.js'
import { compareSuiteVersions, suiteExecutionOwner, suiteInstallOrigin, type SuiteInstalledEntry } from '../domain/suite-install.js'
import { readyRuntimeDependencies } from '../domain/runtime-dependency-selection.js'
import type { CatalogInstallRow, CatalogRequestRow } from '../ports/catalog-records.js'
import type { SuiteUnitOfWork, SuiteRepositories } from '../ports/suite-unit-of-work.js'
import type { Clock } from '../ports/clock.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import { ExecutionAdministration } from './execution-administration.js'
import { writeSuiteSkills } from './suite-skill-facts.js'
import { writeSuitePlugin, type PreparedSuitePlugin } from './suite-plugin-facts.js'
import type { PluginAccessSyntaxPort } from '../ports/plugin-access.js'
import type { SuiteReplacementPlan } from './suite-entry-kinds.js'

export interface PreparedSuiteUpdate {
  readonly installed: CatalogInstallRow
  readonly entry: SuiteCatalogEntry
  readonly runtime: readonly { readonly definition: RuntimeDependencyDefinition; readonly version: RuntimeDependencyVersion }[]
  readonly skills: readonly { readonly item: SuiteCatalogSkillItem; readonly rows: readonly LibrarySkill[] }[]
  readonly note?: LibrarySkill
  readonly plugin?: PreparedSuitePlugin
}

export interface PreparedSuiteInstall extends PreparedSuiteUpdate {
  readonly replacement?: SuiteReplacementPlan
}

/** Prepared facts switch together; publication and artifact collection belong to the caller after COMMIT. */
export class SuiteTransactions {
  constructor(
    private readonly work: SuiteUnitOfWork,
    private readonly dependencies: Pick<RuntimeDependencies, 'transaction'>,
    private readonly clock: Clock,
    private readonly pluginSyntax?: PluginAccessSyntaxPort,
    private readonly compatibilityTarget?: string,
  ) {}
  async update(actor: CommunityAccountActor, input: PreparedSuiteUpdate): Promise<void> {
    const plan = structuredClone(input)
    await this.work.run(
      async rows => {
        await rows.requests.lockLedger()
        await rows.accounts.lock(actor, actor, [])
        const record = await rows.installs.lock(plan.installed.record.id, plan.installed.revision),
          entry = plan.entry,
          origin = suiteInstallOrigin(record.id)
        if (entry.id !== record.id || (record.category && entry.category !== record.category) || compareSuiteVersions(entry.version, record.version) <= 0)
          throw new BusinessRuleError('conflict', 'Review the current catalog version.', 'suite-up-to-date')
        const skip = (kind: SuiteInstalledEntry['kind'], name: string) => record.detached?.some(row => row.kind === kind && row.name === name)
        const pluginDetached = entry.category === 'plugin' && record.detached?.some(row => row.kind === 'plugin')
        if (pluginDetached && (plan.plugin || plan.runtime.length || plan.skills.length))
          throw new BusinessRuleError('conflict', 'The prepared plugin selection changed.', 'suite-task-running')
        if (plan.skills.some(stage => stage.rows.some(row => skip('skill', row.name) || !stage.item.names.includes(row.name))))
          throw new BusinessRuleError('conflict', 'The prepared skill selection changed.', 'suite-task-running')
        const names = plan.skills.flatMap(stage => stage.rows.map(row => row.name)),
          before = (await rows.library.list()).filter(row => row.suiteOrigin === origin),
          removed = before.filter(row => !names.includes(row.name)),
          packs = await rows.packs.store.list(),
          packItem = entry.items.find(item => item.kind === 'skill-pack'),
          executionItems = entry.items.filter(
            (item): item is SuiteCatalogExecutionItem => item.kind === 'execution' && !skip('execution', item.skill) && !skip('skill', item.skill),
          ),
          previousExecution = (await rows.execution.list()).filter(row => row.configuration.suiteOrigin === origin),
          runtimeRows = (await rows.runtime.list()).filter(row => row.managedOrigin === origin)
        await rows.locks.acquire({
          runtimeCommands: [...plan.runtime.flatMap(row => row.version.commands), ...runtimeRows.flatMap(row => row.current?.commands ?? [])],
          executionCommands: [
            ...executionItems.flatMap(item => item.delegated.map(command => command.command)),
            ...previousExecution.flatMap(row => row.configuration.commands.map(command => command.command)),
          ],
          runtime: runtimeRows.map(row => row.name),
          skills: [...names, ...removed.map(row => row.name)],
          packs: packs.filter(pack => pack.suiteOrigin === origin || pack.skills.some(name => removed.some(row => row.name === name))).map(pack => pack.name),
          plugins: plan.plugin ? [plan.plugin.item.packageName] : [],
        })
        // A command-lock wait can advance definitions before parent locks are acquired. Never extend the locked plan afterward.
        const packNames = new Set(
          packs.filter(pack => pack.suiteOrigin === origin || pack.skills.some(name => removed.some(row => row.name === name))).map(pack => pack.name),
        )
        if (
          !isDeepStrictEqual(
            runtimeRows,
            (await rows.runtime.list()).filter(row => row.managedOrigin === origin),
          ) ||
          !isDeepStrictEqual(
            previousExecution,
            (await rows.execution.list()).filter(row => row.configuration.suiteOrigin === origin),
          ) ||
          !isDeepStrictEqual(
            before,
            (await rows.library.list()).filter(row => row.suiteOrigin === origin),
          ) ||
          !isDeepStrictEqual(
            packs.filter(pack => packNames.has(pack.name)),
            (await rows.packs.store.list()).filter(pack => packNames.has(pack.name)),
          )
        )
          throw new BusinessRuleError('conflict', 'Catalog facts changed during preparation. Review the task again.', 'suite-task-running')
        const scope = this.dependencies.transaction(rows.runtime, rows.runtimeReferences),
          dependencyNames = new Map([
            ...Object.entries(record.dependencyNames ?? {}),
            ...runtimeRows.map(row => [row.managedItem ?? row.name, row.name] as const),
          ])
        for (const prepared of plan.runtime) {
          const current = runtimeRows.find(row => row.name === (dependencyNames.get(prepared.definition.name) ?? prepared.definition.name))
          if (!current) {
            if (entry.category !== 'plugin')
              throw new BusinessRuleError('conflict', 'The suite dependency is no longer part of the suite.', 'suite-entry-missing')
            dependencyNames.set(prepared.definition.name, await scope.mutations.commitManaged(origin, prepared.definition, prepared.version))
          } else await scope.mutations.updateManaged(origin, current.name, { ...prepared.definition, name: current.name }, prepared.version)
        }
        const shared = await rows.installs.list()
        const catalogDependencyName = (id: string) => {
          const manual = record.manualDependencies?.find(row => row.id === id)
          if (manual) return manual.name
          const installed = shared.find(row => row.record.id === id && row.record.status === 'installed')
          const name = installed?.record.entries.find(row => row.kind === 'runtime-dependency')?.name
          if (!name) throw new BusinessRuleError('conflict', 'A shared dependency changed.', 'suite-dependency-missing')
          return name
        }
        if (entry.category !== 'dependency') for (const id of entry.dependencies) catalogDependencyName(id)
        const committed: SuiteInstalledEntry[] = []
        if (entry.category === 'plugin' && !pluginDetached) {
          if (
            !plan.plugin ||
            !this.pluginSyntax ||
            !isDeepStrictEqual(
              plan.plugin.item,
              entry.items.find(item => item.kind === 'plugin'),
            )
          )
            throw new BusinessRuleError('invalid', 'Plugin preparation is unavailable.', 'suite-catalog-invalid')
          const dependencies = [
            ...plan.plugin.item.runtimeDependencies.map(name => dependencyNames.get(name) ?? name),
            ...plan.plugin.item.catalogDependencies.map(catalogDependencyName),
          ]
          const plugin = await writeSuitePlugin(rows, origin, plan.plugin, dependencies, 'update', this.pluginSyntax, {
            ...(this.compatibilityTarget ? { compatibilityTarget: this.compatibilityTarget } : {}),
          })
          const retained = entry.items.flatMap(item => (item.kind === 'runtime-dependency' ? [dependencyNames.get(item.name) ?? item.name] : []))
          await scope.mutations.removeManaged(origin, retained)
          committed.push({ kind: 'plugin', name: plugin.packageName })
        }

        for (const stage of plan.skills) {
          const dependencies = [
            ...(stage.item.runtimeDependency ? [dependencyNames.get(stage.item.runtimeDependency) ?? stage.item.runtimeDependency] : []),
            ...(stage.item.catalogDependencies ?? []).map(catalogDependencyName),
          ]
          const written = await writeSuiteSkills(rows, origin, stage.rows, dependencies, { kind: 'update' })
          committed.push(...written.map(row => ({ kind: 'skill' as const, name: row.name })))
        }
        if (packItem && !skip('skill-pack', packItem.name)) {
          const current = (await rows.packs.store.list()).find(row => row.name === packItem.name && row.suiteOrigin === origin)
          if (!current) throw new BusinessRuleError('conflict', 'The suite pack changed.', 'skill-pack-invalid')
          const { note: oldNote, ...metadata } = current
          const note = packItem.note.trim() ? (packItem.note === current.instructions && oldNote ? oldNote : plan.note) : undefined
          if (packItem.note.trim() && !note) throw new BusinessRuleError('conflict', 'The pack note was not prepared.', 'suite-catalog-invalid')
          await rows.packs.store.save(
            {
              ...metadata,
              description: packItem.description,
              instructions: packItem.note,
              skills: [
                ...packItem.skills.filter(name => !skip('skill', name)),
                ...current.skills.filter(name => skip('skill', name) && !packItem.skills.includes(name)),
              ],
              ...(note ? { note: { ...note, published: oldNote?.published ?? false } } : {}),
            },
            current.rowRevision,
          )
        }
        const execution = await this.execution(rows)
        for (const item of executionItems) {
          const owner = suiteExecutionOwner(item.skill),
            template = {
              commands: item.delegated,
              variables: item.variables.map(row => row.name),
              optionalVariables: item.variables.filter(row => row.optional).map(row => row.name),
              runtimeDependencies: [dependencyNames.get(item.runtimeDependency) ?? item.runtimeDependency],
            }
          if (await execution.suiteOwnedSnapshot(origin, owner)) await execution.updateSuiteExecution(origin, owner, template)
          else await execution.commitSuiteExecution(origin, owner, template, {})
          committed.push({ kind: 'execution', name: item.skill })
        }
        await execution.finalizeSuiteExecutions(
          origin,
          executionItems.map(item => ({ owner: suiteExecutionOwner(item.skill), variables: item.variables.map(row => row.name) })),
        )
        await rows.expertReferences.detach(removed.map(row => ({ kind: 'skill', name: row.name })))
        for (const row of removed) await rows.library.remove(row.name, row.rowRevision)
        const { failureCode, ...metadata } = record
        void failureCode
        await rows.installs.save(
          {
            ...metadata,
            status: 'installed',
            version: entry.version,
            category: entry.category,
            dependencyNames: { ...record.dependencyNames, ...Object.fromEntries(dependencyNames) },
            manualDependencies: (record.manualDependencies ?? []).filter(row => entry.category !== 'dependency' && entry.dependencies.includes(row.id)),
            dependencies: entry.category !== 'dependency' ? entry.dependencies : [],
            log: record.log + `\nUpdated to ${entry.version}.`,
            ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
            entries: pluginDetached
              ? record.entries
              : entry.category === 'plugin'
                ? [
                    ...committed,
                    ...(await rows.runtime.list())
                      .filter(row => row.managedOrigin === origin)
                      .map(row => ({ kind: 'runtime-dependency' as const, name: row.name })),
                  ]
                : [
                    ...runtimeRows.filter(row => !skip('runtime-dependency', row.name)).map(row => ({ kind: 'runtime-dependency' as const, name: row.name })),
                    ...committed,
                    ...(packItem && !skip('skill-pack', packItem.name) ? [{ kind: 'skill-pack' as const, name: packItem.name }] : []),
                  ],
            updatedAt: this.clock.now(),
          },
          plan.installed.revision,
        )
        return scope
      },
      scope => scope.committed(),
    )
  }
  async install(actor: CommunityAccountActor, input: readonly PreparedSuiteInstall[], options: SuiteInstallRequest, request: CatalogRequestRow): Promise<void> {
    const units = structuredClone(input),
      choices = structuredClone(options)
    await this.work.run(
      async rows => {
        await rows.requests.lockLedger()
        await rows.accounts.lock(actor, actor, choices.groups ?? [])
        const currentRequest = await rows.requests.get(choices.requestId)
        if (currentRequest?.result.status === 'complete' && currentRequest.result.id === choices.id && currentRequest.result.version === request.result.version)
          return
        if (
          !units.length ||
          new Set(units.map(unit => unit.entry.id)).size !== units.length ||
          request.requestId !== choices.requestId ||
          !units.some(unit => unit.entry.id === choices.id)
        )
          throw new BusinessRuleError('invalid', 'Invalid prepared catalog install.', 'suite-catalog-invalid')
        const records = new Map<string, CatalogInstallRow['record']>()
        for (const unit of [...units].sort((a, b) => a.entry.id.localeCompare(b.entry.id))) {
          const record = await rows.installs.lock(unit.entry.id, unit.installed.revision)
          if (record.status !== 'installing' || record.version !== unit.entry.version)
            throw new BusinessRuleError('conflict', 'The prepared catalog task changed.', 'suite-task-running')
          records.set(record.id, record)
        }
        const runtimeNames = new Set(
            units.flatMap(unit => [
              ...unit.runtime.map(row => row.definition.name),
              ...[...(unit.replacement?.dependencies.values() ?? [])].map(row => row.name),
            ]),
          ),
          skillNames = new Set(
            units.flatMap(unit => [...unit.skills.flatMap(stage => stage.rows.map(row => row.name)), ...(unit.replacement?.skills ?? []).map(row => row.name)]),
          ),
          packNames = new Set(units.flatMap(unit => unit.entry.items.flatMap(item => (item.kind === 'skill-pack' ? [item.name] : [])))),
          executionNames = new Set(
            units.flatMap(unit => [
              ...unit.entry.items.flatMap(item => (item.kind === 'execution' ? [suiteExecutionOwner(item.skill)] : [])),
              ...(unit.replacement?.executions ?? []).map(row => row.owner),
            ]),
          ),
          runtimeBefore = (await rows.runtime.list()).filter(row => runtimeNames.has(row.name)),
          libraryBefore = (await rows.library.list()).filter(row => skillNames.has(row.name)),
          packsBefore = (await rows.packs.store.list()).filter(row => packNames.has(row.name)),
          executionBefore = (await rows.execution.list()).filter(row => executionNames.has(row.owner))
        await rows.locks.acquire({
          runtimeCommands: [
            ...units.flatMap(unit => unit.runtime.flatMap(row => row.version.commands)),
            ...runtimeBefore.flatMap(row => row.current?.commands ?? []),
          ],
          executionCommands: [
            ...units.flatMap(unit => unit.entry.items.flatMap(item => (item.kind === 'execution' ? item.delegated.map(row => row.command) : []))),
            ...executionBefore.flatMap(row => row.configuration.commands.map(row => row.command)),
          ],
          runtime: [...runtimeNames],
          skills: [...skillNames],
          packs: [...packNames],
          plugins: units.flatMap(unit => (unit.plugin ? [unit.plugin.item.packageName] : [])),
        })
        if (
          !isDeepStrictEqual(
            runtimeBefore,
            (await rows.runtime.list()).filter(row => runtimeNames.has(row.name)),
          ) ||
          !isDeepStrictEqual(
            libraryBefore,
            (await rows.library.list()).filter(row => skillNames.has(row.name)),
          ) ||
          !isDeepStrictEqual(
            packsBefore,
            (await rows.packs.store.list()).filter(row => packNames.has(row.name)),
          ) ||
          !isDeepStrictEqual(
            executionBefore,
            (await rows.execution.list()).filter(row => executionNames.has(row.owner)),
          )
        )
          throw new BusinessRuleError('conflict', 'Catalog facts changed during preparation. Review the task again.', 'suite-task-running')
        const scope = this.dependencies.transaction(rows.runtime, rows.runtimeReferences),
          aliases = new Map<string, ReadonlyMap<string, string>>()
        for (const unit of units) {
          const entry = unit.entry,
            origin = suiteInstallOrigin(entry.id),
            record = records.get(entry.id)!,
            names = new Map<string, string>()
          for (const prepared of unit.runtime) {
            const replaced = unit.replacement?.dependencies.get(prepared.definition.name)
            names.set(
              prepared.definition.name,
              replaced
                ? await scope.mutations.replaceManaged(origin, replaced, prepared.definition, prepared.version)
                : await scope.mutations.commitManaged(origin, prepared.definition, prepared.version),
            )
          }
          aliases.set(entry.id, names)
          const shared = await rows.installs.list()
          const dependencyName = (id: string) => {
            const manual = record.manualDependencies?.find(row => row.id === id)
            if (manual) return manual.name
            const prepared = aliases.get(id)?.values().next().value
            if (prepared) return prepared
            const existing = shared
              .find(row => row.record.id === id && row.record.status === 'installed')
              ?.record.entries.find(row => row.kind === 'runtime-dependency')?.name
            if (!existing) throw new BusinessRuleError('conflict', 'A shared dependency changed.', 'suite-dependency-missing')
            return existing
          }
          if (entry.category !== 'dependency') for (const id of entry.dependencies) dependencyName(id)
          if (entry.category === 'plugin') {
            if (
              !unit.plugin ||
              !this.pluginSyntax ||
              !isDeepStrictEqual(
                unit.plugin.item,
                entry.items.find(item => item.kind === 'plugin'),
              )
            )
              throw new BusinessRuleError('invalid', 'Plugin preparation is unavailable.', 'suite-catalog-invalid')
            const dependencies = [
              ...unit.plugin.item.runtimeDependencies.map(name => names.get(name) ?? name),
              ...unit.plugin.item.catalogDependencies.map(dependencyName),
            ]
            const takeover = unit.replacement?.plugins?.find(row => row.row.packageName === unit.plugin!.item.packageName)
            await writeSuitePlugin(rows, origin, unit.plugin, dependencies, 'install', this.pluginSyntax, {
              ...(this.compatibilityTarget ? { compatibilityTarget: this.compatibilityTarget } : {}),
              ...(takeover ? { takeover } : {}),
            })
          }
          const installedSkills: string[] = []
          for (const stage of unit.skills) {
            const dependencies = [
              ...(stage.item.runtimeDependency ? [names.get(stage.item.runtimeDependency) ?? stage.item.runtimeDependency] : []),
              ...(stage.item.catalogDependencies ?? []).map(dependencyName),
            ]
            const written = await writeSuiteSkills(rows, origin, stage.rows, dependencies, { kind: 'install', replacing: unit.replacement?.skills ?? [] })
            installedSkills.push(...written.map(row => row.name))
          }
          const pack = entry.items.find(item => item.kind === 'skill-pack')
          if (pack) {
            const current = (await rows.packs.store.list()).find(row => row.name === pack.name)
            if ((current && current.suiteOrigin !== origin) || (pack.note.trim() && !unit.note))
              throw new BusinessRuleError('conflict', 'The prepared skill pack changed.', 'skill-pack-invalid')
            await rows.packs.store.save(
              {
                name: pack.name,
                description: pack.description,
                skills: pack.skills,
                instructions: pack.note,
                published: entry.id === choices.id && choices.publish === true,
                suiteOrigin: origin,
                ...(current?.rowRevision === undefined ? {} : { rowRevision: current.rowRevision }),
                ...(pack.note.trim() && unit.note ? { note: unit.note } : {}),
              },
              current?.rowRevision ?? 'none',
            )
            if (entry.id === choices.id) {
              const groups = new Set((await rows.accounts.listGroups()).map(group => group.id))
              for (const id of choices.groups ?? [])
                if (groups.has(id)) await rows.packs.grants.set(id, [...new Set([...(await rows.packs.grants.get(id)), pack.name])])
            }
          }
          const execution = await this.execution(rows),
            executions = entry.items.filter((item): item is SuiteCatalogExecutionItem => item.kind === 'execution')
          for (const item of executions) {
            const credentials = Object.fromEntries(
              item.variables
                .filter(variable => choices.credentials?.[variable.name] !== undefined)
                .map(variable => [variable.name, choices.credentials![variable.name]!]),
            )
            await execution.commitSuiteExecution(
              origin,
              suiteExecutionOwner(item.skill),
              {
                commands: item.delegated,
                variables: item.variables.map(row => row.name),
                optionalVariables: item.variables.filter(row => row.optional).map(row => row.name),
                runtimeDependencies: [names.get(item.runtimeDependency) ?? item.runtimeDependency],
              },
              credentials,
              unit.replacement?.executions ?? [],
            )
          }
          await execution.finalizeSuiteExecutions(
            origin,
            executions.map(item => ({ owner: suiteExecutionOwner(item.skill), variables: item.variables.map(row => row.name) })),
          )
          const entries: SuiteInstalledEntry[] = entry.items.flatMap((item): SuiteInstalledEntry[] =>
            item.kind === 'runtime-dependency'
              ? [{ kind: item.kind, name: names.get(item.name) ?? item.name }]
              : item.kind === 'skill'
                ? item.names.filter(name => installedSkills.includes(name)).map(name => ({ kind: 'skill', name }))
                : item.kind === 'skill-pack'
                  ? [{ kind: item.kind, name: item.name }]
                  : item.kind === 'execution'
                    ? [{ kind: item.kind, name: item.skill }]
                    : item.kind === 'plugin'
                      ? [{ kind: item.kind, name: item.packageName }]
                      : [],
          )
          const replaced: SuiteInstalledEntry[] = [
            ...[...(unit.replacement?.dependencies.values() ?? [])].map(row => ({ kind: 'runtime-dependency' as const, name: row.name })),
            ...(unit.replacement?.skills ?? []).map(row => ({ kind: 'skill' as const, name: row.name })),
            ...(unit.replacement?.plugins ?? []).map(({ row }) => ({ kind: 'plugin' as const, name: row.packageName })),
          ]
          await rows.installs.save(
            {
              ...record,
              status: 'installed',
              entries,
              dependencyNames: Object.fromEntries(names),
              ...(replaced.length ? { replaced } : {}),
              updatedAt: this.clock.now(),
              log: record.log + '\nInstalled.',
            },
            unit.installed.revision,
          )
        }
        const installedIds = new Set(units.map(unit => unit.entry.id))
        for (const current of await rows.installs.list()) {
          if (installedIds.has(current.record.id) || !current.record.manualDependencies?.some(row => installedIds.has(row.id))) continue
          const { manualDependencies, ...metadata } = current.record
          const retained = manualDependencies.filter(row => !installedIds.has(row.id))
          await rows.installs.save({ ...metadata, ...(retained.length ? { manualDependencies: retained } : {}) }, current.revision)
        }
        // Expired requests must not be resurrected or overwrite a later reuse of their id.
        if (currentRequest?.revision === request.revision)
          await rows.requests.save(choices.requestId, { id: choices.id, version: request.result.version, status: 'complete' }, request.revision)
        return scope
      },
      scope => scope?.committed(),
    )
  }
  private async execution(rows: SuiteRepositories): Promise<ExecutionAdministration> {
    const library = await rows.library.list()
    return new ExecutionAdministration(
      rows.accounts,
      {
        get: id => {
          const skill = library.find(row => id === suiteExecutionOwner(row.name))
          return skill ? { id, version: skill.hash } : undefined
        },
        owns: async () => false,
      },
      rows.execution,
      async () => {},
      undefined,
      undefined,
      { readReady: async names => readyRuntimeDependencies(await rows.runtime.list(), names) },
    )
  }
}
