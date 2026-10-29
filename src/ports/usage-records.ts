import type {
  UsageCapability,
  UsageEntry,
  UsageMember,
  UsageQuery,
  UsageRecordsView,
  UsageModelBucket,
  UsageModelQuery,
  UsageModelView,
  UsageReportedBucket,
  UsageReportedQuery,
  UsageReportedView,
} from '../domain/usage-record.js'
export interface UsageRecordsPort {
  appendReported(entries: readonly UsageReportedBucket[]): Promise<void>
  reported(query: UsageReportedQuery): Promise<UsageReportedView>
  appendModel(entry: UsageModelBucket): Promise<void>
  models(query: UsageModelQuery): Promise<UsageModelView>
  append(entry: UsageEntry): Promise<void>
  prune(before: number): Promise<void>
  retentionDays(): Promise<number>
  saveRetention(days: number): Promise<void>
  view(query: UsageQuery): Promise<UsageRecordsView>
}
/** Supplied programmatically; deployments have no setting that changes the default admission. */
export interface UsageDecisionPort {
  allow(member: UsageMember, capability: UsageCapability): boolean
}
