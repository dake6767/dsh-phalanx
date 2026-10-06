import type { CommunitySystemUpdateAction } from '../domain/admin-contract.js'
import { CommunityRequestError } from './community-request.js'

/** Closed browser capability: root selects the trusted source itself. */
export function communitySystemUpdateInput(value: unknown): CommunitySystemUpdateAction {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const input = value as Record<string, unknown>
    const keys = Object.keys(input).sort().join(',')
    if (input.action === 'check' && keys === 'action') return { action: 'check' }
    if (input.action === 'prepare' && keys === 'action,manifestSha256,version' && typeof input.version === 'string' && typeof input.manifestSha256 === 'string')
      return { action: 'prepare', version: input.version, manifestSha256: input.manifestSha256 }
    if (input.action === 'apply' && keys === 'action,confirmed,operation' && input.confirmed === true && typeof input.operation === 'string')
      return { action: 'apply', operation: input.operation, confirmed: true }
  }
  throw new CommunityRequestError(400, 'Invalid system update action')
}
