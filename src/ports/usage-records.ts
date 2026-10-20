import type { UsageCapability, UsageEntry, UsageMember, UsageQuery, UsageRecordsView, UsageModelBucket, UsageModelQuery, UsageModelView } from '../domain/usage-record.js'
export interface UsageRecordsPort {
  appendModel(entry: UsageModelBucket): void
  models(query: UsageModelQuery): UsageModelView
  append(entry: UsageEntry): void
  prune(before: number): void
  retentionDays(): number
  saveRetention(days: number): void
  view(query: UsageQuery): UsageRecordsView
}
/** Supplied programmatically; deployments have no setting that changes the default admission. */
export interface UsageDecisionPort { allow(member: UsageMember, capability: UsageCapability): boolean }
