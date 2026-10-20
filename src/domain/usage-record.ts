import type { ExecutionFailureCode } from './platform-execution.js'
/** Usage metadata deliberately excludes request parameters, bodies and output. */
export interface UsageCapability { readonly kind: 'plugin-upstream' | 'mcp' | 'web-tools' | 'execution' | 'model'; readonly id: string; readonly operation: string; readonly firstArgument?: string }
export interface UsageMember { readonly username: string; readonly groupId: string | null }
export interface UsageResult {
  readonly outcome: 'succeeded' | 'failed' | 'denied'
  readonly httpStatus?: number
  readonly isError?: boolean
  readonly exitCode?: number
  readonly tokens?: ModelTokenUsage
  readonly usageUnknown?: boolean
  readonly reason?: 'access' | 'policy' | 'transport' | 'cancelled' | 'blocked' | ExecutionFailureCode
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
export interface UsageCount { readonly key: string; readonly count: number; readonly capability?: UsageCapability }
export interface UsageRecordsView {
  readonly items: readonly UsageRecord[]; readonly total: number; readonly page: number; readonly pageCount: number
  readonly summaries: { readonly members: readonly UsageCount[]; readonly groups: readonly UsageCount[]; readonly capabilities: readonly UsageCount[]; readonly days: readonly UsageCount[] }
}

/** Missing upstream counters remain unknown, including when only part of a stream was read. */
export interface ModelTokenUsage { readonly input: number | null; readonly output: number | null; readonly cacheRead: number | null; readonly cacheWrite: number | null }
export interface UsageModelBucket extends UsageMember {
  readonly modelId: string; readonly hour: number; readonly tokens: ModelTokenUsage
  readonly requests: number; readonly unknownRequests: number; readonly deniedRequests: number
}
export type UsageModelTotal = Omit<UsageModelBucket, 'hour' | 'groupId'>
export interface UsageModelQuery { readonly from?: number; readonly until?: number; readonly username?: string; readonly groupId?: string; readonly modelId?: string }
export interface UsageModelView { readonly items: readonly UsageModelTotal[]; readonly summaries: UsageRecordsView['summaries'] }
