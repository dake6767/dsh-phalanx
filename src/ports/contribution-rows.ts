import type { MemberContribution } from '../domain/member-contribution.js'

export interface ContributionRecord {
  readonly row: MemberContribution
  readonly revision: string
}
/** A request-local row and its optimistic identity; no process-wide contribution snapshot. */
export interface ContributionRows {
  lockName(kind: 'skill' | 'plugin', name: string): Promise<void>
  get(id: string): Promise<ContributionRecord | undefined>
  list(): Promise<readonly ContributionRecord[]>
  save(row: MemberContribution, expectedRevision?: string): Promise<void>
  remove(id: string, expectedRevision: string): Promise<void>
  lock(id: string, expectedRevision: string): Promise<MemberContribution>
}
