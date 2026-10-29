import { isDeepStrictEqual } from 'node:util'
import { BusinessRuleError } from '../domain/business-error.js'
import type { Expert, ExpertState } from '../domain/expert.js'
import type { ExpertPolicyView, ExpertRepositories, ExpertSnapshot, ExpertStorePort } from '../ports/experts.js'
import type { PlatformUnitOfWorkPort } from '../ports/platform-unit-of-work.js'

const record = (expert: Expert) => {
  const { rowRevision, ...value } = expert
  void rowRevision
  return value
}
const names = (values: readonly string[] | undefined) => (values === undefined ? undefined : [...new Set(values)].sort())

/** A temporary application projection becomes independent row changes in one use-case transaction. */
export class ExpertDesiredState implements ExpertStorePort {
  private readonly writes = new Set<Promise<void>>()
  private stopped = false
  constructor(
    private readonly query: Pick<ExpertStorePort, 'read'>,
    private readonly work: PlatformUnitOfWorkPort<ExpertRepositories>,
    readonly view: ExpertPolicyView,
  ) {}
  read(): Promise<ExpertSnapshot> {
    if (this.stopped) return Promise.reject(Error('Expert storage is closed'))
    return this.query.read()
  }
  update(previous: ExpertSnapshot, next: ExpertState): Promise<void> {
    if (this.stopped) return Promise.reject(Error('Expert storage is closed'))
    const writing = this.apply(previous, next)
    this.writes.add(writing)
    return writing.finally(() => {
      this.writes.delete(writing)
    })
  }
  async stop(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.writes])
  }
  private async apply(previous: ExpertSnapshot, next: ExpertState): Promise<void> {
    if (new Set(next.experts.map(row => row.id)).size !== next.experts.length) throw new BusinessRuleError('invalid', 'Duplicate experts.', 'expert-invalid')
    const old = new Map(previous.experts.map(row => [row.id, row]))
    const modified = next.experts.filter(row => !old.has(row.id) || !isDeepStrictEqual(record(old.get(row.id)!), record(row)))
    const removed = previous.experts.filter(row => !next.experts.some(value => value.id === row.id))
    const groups = [...new Set([...Object.keys(previous.grants), ...Object.keys(next.grants)])]
      .sort()
      .filter(id => !isDeepStrictEqual(names(previous.grants[id]), names(next.grants[id])))
    const spaces = [...new Set([...Object.keys(previous.selections), ...Object.keys(next.selections)])]
      .sort()
      .filter(id => !isDeepStrictEqual(names(previous.selections[id]), names(next.selections[id])))
    if (!modified.length && !removed.length && !groups.length && !spaces.length) return
    const targets = new Set([...modified, ...removed].map(row => row.id))
    for (const group of groups) for (const id of next.grants[group] ?? []) targets.add(id)
    for (const space of spaces) for (const id of next.selections[space] ?? []) targets.add(id)
    await this.work.run(async rows => {
      // Policy owners and capability parents precede every expert row lock.
      // Assignment repositories recheck their own parents when saving.
      for (const id of groups) await rows.grants.lockOwner(id, Object.hasOwn(next.grants, id))
      for (const id of spaces) await rows.selections.lockOwner(id, Object.hasOwn(next.selections, id))
      await rows.experts.lockReferences([...modified, ...removed])
      for (const id of [...targets].sort()) await rows.experts.lock(id, previous.versions.experts[id] ?? 'none')
      for (const row of modified.filter(row => !old.has(row.id))) await rows.experts.save(row, 'none')
      for (const id of groups) {
        if (Object.hasOwn(next.grants, id)) await rows.grants.save(id, names(next.grants[id])!, previous.versions.groups[id] ?? 'none')
        else await rows.grants.remove(id, previous.versions.groups[id] ?? 'none')
      }
      for (const id of spaces) {
        if (Object.hasOwn(next.selections, id)) await rows.selections.save(id, names(next.selections[id])!, previous.versions.members[id] ?? 'none')
        else await rows.selections.remove(id, previous.versions.members[id] ?? 'none')
      }
      for (const row of modified.filter(row => old.has(row.id))) await rows.experts.save(row, previous.versions.experts[row.id]!)
      for (const row of removed) await rows.experts.remove(row.id, previous.versions.experts[row.id]!)
      await rows.metadata.advance()
    })
  }
}
