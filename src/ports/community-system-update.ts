import type { CommunitySystemUpdateCheckResult, CommunitySystemUpdateStatus, CommunitySystemUpdateSubmission } from '../domain/admin-contract.js'

/** Fixed project release control; no process, URL or deployment path capability. */
export interface CommunitySystemUpdatePort {
  status(operation?: string): Promise<CommunitySystemUpdateStatus>
  check(): Promise<CommunitySystemUpdateCheckResult>
  prepare(version: string, manifestSha256: string): Promise<CommunitySystemUpdateSubmission>
  apply(operation: string): Promise<CommunitySystemUpdateSubmission>
}
export class CommunitySystemUpdateUnavailableError extends Error { readonly code = 'update-service-unavailable' as const }
