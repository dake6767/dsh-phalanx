import type { CommunityErrorCode, CommunityErrorParams } from './admin-contract.js'
/** Expected operator action failures; the transport maps kinds to responses. */
export class BusinessRuleError extends Error {
  constructor(readonly kind: 'invalid' | 'forbidden' | 'missing' | 'conflict', message: string, readonly code: CommunityErrorCode, readonly params?: CommunityErrorParams) {
    super(message)
  }
}
