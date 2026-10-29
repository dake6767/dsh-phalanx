import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CatalogInstallRecord } from '../domain/catalog-install.js'
import type { SuiteInstallRequest } from '../domain/suite-catalog.js'
import type { CatalogInstallRow, CatalogRequestRow } from '../ports/catalog-records.js'
import type { Clock } from '../ports/clock.js'
import type { SuiteUnitOfWork } from '../ports/suite-unit-of-work.js'

interface AdmittedTask {
  readonly installs: readonly CatalogInstallRow[]
  readonly request: CatalogRequestRow
}

const busy = () => new BusinessRuleError('conflict', 'A catalog task already holds this entry or request.', 'suite-task-running')

/** Persists external task progress and receipts without recording compensation snapshots or credentials. */
export class SuiteTaskRecords {
  constructor(
    private readonly work: SuiteUnitOfWork,
    private readonly clock: Clock,
  ) {}
  admit(actor: CommunityAccountActor, input: readonly CatalogInstallRecord[], options: SuiteInstallRequest): Promise<AdmittedTask> {
    const accepted = structuredClone({ actor, input, options })
    let committed: AdmittedTask | undefined
    return this.work
      .run(
        async rows => {
          await rows.requests.lockLedger()
          await rows.accounts.lock(accepted.actor, accepted.actor, accepted.options.groups ?? [])
          if (await rows.requests.get(accepted.options.requestId)) throw busy()
          const primary = accepted.input.find(row => row.id === accepted.options.id)
          if (!primary || new Set(accepted.input.map(row => row.id)).size !== accepted.input.length || accepted.input.some(row => row.status !== 'installing'))
            throw new BusinessRuleError('invalid', 'Invalid catalog task admission.', 'suite-catalog-invalid')
          for (const record of [...accepted.input].sort((a, b) => a.id.localeCompare(b.id))) {
            const previous = await rows.installs.get(record.id)
            if (previous && previous.record.status !== 'failed') throw busy()
            await rows.installs.save(record, previous?.revision ?? 'none')
          }
          await rows.requests.save(accepted.options.requestId, { id: primary.id, version: primary.version, status: 'pending' })
          return {
            installs: await Promise.all(accepted.input.map(async record => (await rows.installs.get(record.id))!)),
            request: (await rows.requests.get(accepted.options.requestId))!,
          }
        },
        value => {
          committed = value
        },
      )
      .catch(error => {
        if (committed) return committed
        throw error
      })
  }
  failInstall(
    input: readonly CatalogInstallRow[],
    request: CatalogRequestRow,
    failureCode: string,
    message: string,
    previous: readonly CatalogInstallRow[] = [],
  ): Promise<void> {
    const accepted = structuredClone({ input, request, previous })
    return this.work.run(async rows => {
      await rows.requests.lockLedger()
      for (const task of [...accepted.input].sort((a, b) => a.record.id.localeCompare(b.record.id))) {
        const current = await rows.installs.get(task.record.id)
        // A late external callback must not rewrite a later task, a completed install or a retired row.
        if (!current || current.revision !== task.revision || current.record.status !== 'installing') continue
        const old = accepted.previous.find(row => row.record.id === task.record.id)
        if (task.record.id !== accepted.request.result.id) {
          if (old) await rows.installs.save(old.record, current.revision)
          else await rows.installs.remove(task.record.id, current.revision)
        } else
          await rows.installs.save(
            {
              ...current.record,
              status: 'failed',
              failureCode,
              entries: [],
              updatedAt: this.clock.now(),
              log: current.record.log + '\n' + message,
            },
            current.revision,
          )
      }
      const current = await rows.requests.get(accepted.request.requestId)
      if (current?.revision === accepted.request.revision)
        await rows.requests.save(current.requestId, { ...current.result, status: 'failed' }, current.revision)
    })
  }
}
