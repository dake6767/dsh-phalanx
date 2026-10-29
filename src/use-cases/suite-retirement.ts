import { isDeepStrictEqual } from 'node:util'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { suiteExecutionOwner, suiteInstallOrigin, suiteOwnedReferences, type SuiteInstalledEntry } from '../domain/suite-install.js'
import type { CatalogInstallRow } from '../ports/catalog-records.js'
import type { Clock } from '../ports/clock.js'
import type { SuiteRepositories, SuiteUnitOfWork } from '../ports/suite-unit-of-work.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'

const changed = () => new BusinessRuleError('conflict', 'Catalog facts changed. Review the task again.', 'suite-task-running')
const referenced = (references: readonly string[]) =>
  new BusinessRuleError('conflict', 'Suite entries are still referenced.', 'runtime-dependency-referenced', { references: references.join(', ') })

/** Removes or detaches one catalog owner; external cleanup reads the committed facts afterward. */
export class SuiteRetirement {
  constructor(
    private readonly work: SuiteUnitOfWork,
    private readonly dependencies: Pick<RuntimeDependencies, 'transaction'>,
    private readonly clock: Clock,
  ) {}
  async remove(actor: CommunityAccountActor, input: CatalogInstallRow, expertRevision?: string): Promise<void> {
    const installed = structuredClone(input)
    await this.work.run(
      async rows => {
        await rows.requests.lockLedger()
        await rows.accounts.lockDirectory()
        const origin = suiteInstallOrigin(installed.record.id),
          before = await this.owned(rows, origin),
          groups = await this.groups(rows, before)
        await rows.accounts.lock(actor, actor, groups)
        const record = await rows.installs.lock(installed.record.id, installed.revision)
        if (!['installed', 'failed', 'uninstalling'].includes(record.status)) throw changed()
        const packs = await rows.packs.store.list()
        await rows.locks.acquire({
          retiringChoices: true,
          runtimeCommands: before.runtime.flatMap(row => row.current?.commands ?? []),
          executionCommands: before.execution.flatMap(row => row.configuration.commands.map(row => row.command)),
          runtime: before.runtime.map(row => row.name),
          skills: before.skills.map(row => row.name),
          packs: packs
            .filter(pack => pack.suiteOrigin === origin || pack.skills.some(name => before.skills.some(row => row.name === name)))
            .map(row => row.name),
          plugins: before.plugins.map(row => row.packageName),
        })
        if (!isDeepStrictEqual(before, await this.owned(rows, origin)) || (await this.groups(rows, before)).some(id => !groups.includes(id))) throw changed()
        const owned = suiteOwnedReferences(record),
          blocking: string[] = []
        for (const row of before.runtime)
          blocking.push(
            ...(await rows.runtimeReferences.list(row.name))
              .filter(reference => !owned.has(`${reference.kind}:${reference.name}`))
              .map(reference => `${reference.kind}: ${reference.name}`),
          )
        blocking.push(
          ...(await rows.packs.store.list())
            .filter(pack => !pack.suiteOrigin && pack.skills.some(name => before.skills.some(row => row.name === name)))
            .map(pack => `skill-pack: ${pack.name}`),
        )
        blocking.push(
          ...(await rows.installs.list())
            .filter(row => row.record.id !== record.id && row.record.status !== 'failed' && row.record.dependencies?.includes(record.id))
            .map(row => `suite: ${row.record.id}`),
        )
        if (blocking.length) throw referenced(blocking)
        await rows.expertReferences.detach(
          [
            ...before.skills.map(row => ({ kind: 'skill' as const, name: row.name })),
            ...before.packs.map(row => ({ kind: 'pack' as const, name: row.name })),
            ...before.plugins.map(row => ({ kind: 'plugin' as const, name: row.packageName })),
          ],
          expertRevision,
        )
        for (const row of before.packs) await rows.packs.store.remove(row.name, row.rowRevision)
        for (const row of before.execution) await rows.execution.remove(row.owner, row.configuration.rowRevision)
        for (const row of before.skills) await rows.library.remove(row.name, row.rowRevision)
        for (const row of before.plugins) await rows.plugins.remove(row.packageName, row.revision)
        const scope = this.dependencies.transaction(rows.runtime, rows.runtimeReferences)
        await scope.mutations.removeManaged(origin)
        await rows.installs.remove(record.id, installed.revision)
        if (record.requestId) {
          const request = await rows.requests.get(record.requestId)
          if (request?.result.id === record.id) await rows.requests.save(record.requestId, { ...request.result, status: 'retired' }, request.revision)
        }
        return scope
      },
      scope => scope.committed(),
    )
  }
  async detach(actor: CommunityAccountActor, input: CatalogInstallRow, requested: SuiteInstalledEntry): Promise<void> {
    const installed = structuredClone(input),
      target = structuredClone(requested)
    await this.work.run(
      async rows => {
        await rows.requests.lockLedger()
        await rows.accounts.lock(actor, actor, [])
        const record = await rows.installs.lock(installed.record.id, installed.revision),
          origin = suiteInstallOrigin(record.id)
        if (!['installed', 'failed'].includes(record.status)) throw changed()
        if (
          (await rows.installs.list()).some(
            row => row.record.id !== record.id && row.record.dependencies?.includes(record.id) && !['installed', 'failed'].includes(row.record.status),
          )
        )
          throw changed()
        const entry = record.entries.find(row => row.kind === target.kind && row.name === target.name)
        if (!entry) throw new BusinessRuleError('missing', 'This entry is not part of the suite.', 'suite-entry-missing')
        const before = await this.owned(rows, origin),
          targets = [entry]
        if (entry.kind === 'skill') targets.push(...record.entries.filter(row => row.kind === 'execution' && row.name === entry.name))
        if (entry.kind === 'plugin') {
          const dependencies = before.plugins.find(row => row.packageName === entry.name)?.runtimeDependencies ?? []
          targets.push(...record.entries.filter(row => row.kind === 'runtime-dependency' && dependencies.includes(row.name)))
        }
        const includes = (kind: SuiteInstalledEntry['kind'], name: string) => targets.some(row => row.kind === kind && row.name === name)
        await rows.locks.acquire({
          runtimeCommands: before.runtime.filter(row => includes('runtime-dependency', row.name)).flatMap(row => row.current?.commands ?? []),
          executionCommands: before.execution
            .filter(row => targets.some(target => target.kind === 'execution' && row.owner === suiteExecutionOwner(target.name)))
            .flatMap(row => row.configuration.commands.map(row => row.command)),
          runtime: targets.filter(row => row.kind === 'runtime-dependency').map(row => row.name),
          skills: targets.filter(row => row.kind === 'skill').map(row => row.name),
          packs: targets.filter(row => row.kind === 'skill-pack').map(row => row.name),
          plugins: targets.filter(row => row.kind === 'plugin').map(row => row.name),
        })
        if (!isDeepStrictEqual(before, await this.owned(rows, origin))) throw changed()
        for (const row of before.skills.filter(row => includes('skill', row.name))) {
          const { suiteOrigin, ...manual } = row
          void suiteOrigin
          await rows.library.save(manual)
        }
        for (const row of before.packs.filter(row => includes('skill-pack', row.name))) {
          const { suiteOrigin, ...manual } = row
          void suiteOrigin
          await rows.packs.store.save(manual, row.rowRevision)
        }
        for (const row of before.plugins.filter(row => includes('plugin', row.packageName))) {
          const { suiteOrigin, suiteAppliedAccess, ...manual } = row
          void suiteOrigin
          void suiteAppliedAccess
          await rows.plugins.save(manual)
        }
        for (const row of before.execution.filter(row =>
          targets.some(target => target.kind === 'execution' && row.owner === suiteExecutionOwner(target.name)),
        )) {
          const { suiteOrigin, ...manual } = row.configuration
          void suiteOrigin
          await rows.execution.save(row.owner, manual)
        }
        const scope = this.dependencies.transaction(rows.runtime, rows.runtimeReferences)
        for (const target of targets.filter(row => row.kind === 'runtime-dependency')) await scope.mutations.detachManaged(origin, target.name)
        await rows.installs.save(
          {
            ...record,
            status: 'installed',
            entries: record.entries.filter(row => !includes(row.kind, row.name)),
            detached: [...(record.detached ?? []), ...targets.filter(row => !record.detached?.some(old => old.kind === row.kind && old.name === row.name))],
            updatedAt: this.clock.now(),
            log: record.log + targets.map(row => `\nDetached ${row.kind} ${row.name}.`).join(''),
          },
          installed.revision,
        )
        return scope
      },
      scope => scope.committed(),
    )
  }
  private async owned(rows: SuiteRepositories, origin: string) {
    return {
      skills: (await rows.library.list()).filter(row => row.suiteOrigin === origin),
      packs: (await rows.packs.store.list()).filter(row => row.suiteOrigin === origin),
      plugins: (await rows.plugins.list()).filter(row => row.suiteOrigin === origin),
      runtime: (await rows.runtime.list()).filter(row => row.managedOrigin === origin),
      execution: (await rows.execution.list()).filter(row => row.configuration.suiteOrigin === origin),
    }
  }
  private async groups(rows: SuiteRepositories, facts: Awaited<ReturnType<SuiteRetirement['owned']>>): Promise<readonly string[]> {
    const ids: string[] = []
    for (const group of await rows.accounts.listGroups()) {
      const skills = await rows.grants.get(group.id),
        packs = await rows.packs.grants.get(group.id),
        plugins = [...(await rows.pluginGrants.get(group.id)), ...(await rows.pluginGrants.preinstalls(group.id))]
      if (
        facts.skills.some(row => skills.includes(row.name)) ||
        facts.packs.some(row => packs.includes(row.name)) ||
        facts.plugins.some(row => plugins.includes(row.packageName))
      )
        ids.push(group.id)
    }
    return ids
  }
}
