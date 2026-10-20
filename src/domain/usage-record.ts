/** Usage metadata deliberately excludes request parameters, bodies and output. */
export interface UsageCapability { readonly kind: 'plugin-upstream'; readonly id: string; readonly operation: string }
export interface UsageMember { readonly username: string; readonly groupId: string | null }
export interface UsageResult {
  readonly outcome: 'succeeded' | 'failed' | 'denied'
  readonly httpStatus?: number
  readonly reason?: 'access' | 'policy' | 'transport' | 'cancelled'
}
export interface UsageEntry extends UsageMember, UsageResult {
  readonly startedAt: number
  readonly durationMs: number
  readonly capability: UsageCapability
}
export interface UsageRecord extends UsageEntry { readonly id: number }
export interface UsageQuery {
  readonly from?: number; readonly until?: number; readonly username?: string; readonly groupId?: string
  readonly capability?: string; readonly operation?: string; readonly outcome?: UsageResult['outcome']; readonly page?: number
}
export interface UsageCount { readonly key: string; readonly count: number }
export interface UsageRecordsView {
  readonly items: readonly UsageRecord[]; readonly total: number; readonly page: number; readonly pageCount: number
  readonly summaries: { readonly members: readonly UsageCount[]; readonly groups: readonly UsageCount[]; readonly capabilities: readonly UsageCount[]; readonly days: readonly UsageCount[] }
}
