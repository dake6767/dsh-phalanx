/** Current identity facts needed by entry and default model authorization. */
export interface CommunityAccountState {
  readonly username: string
  readonly spaceId: string
  readonly disabled: boolean
  readonly sessionEpoch: number
}

/** Server-verified caller captured when admitting a management request. */
export type CommunityAccountActor = Pick<CommunityAccountState, 'username' | 'spaceId' | 'sessionEpoch'>

/** Public account facts. Password hashes remain private to the store adapter. */
export interface CommunityAccountRecord extends CommunityAccountState {
  readonly email: string
  readonly admin: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CommunityCreateAccountInput {
  readonly username: string
  readonly email: string
  readonly password: string
}

export class CommunityAuthenticationError extends Error {}

export class CommunityAccountOperationError extends Error {
  readonly reason = 'instance-stop-failed'
  constructor(action: 'disable' | 'enable' | 'delete', options?: ErrorOptions) {
    super(`${action === 'delete' ? 'Deletion is incomplete' : action === 'enable' ? 'Enable failed' : 'Disable is incomplete'}: the user instance could not be stopped. The account remains disabled; retry the action.`, options)
  }
}

export function validateCommunityPassword(password: string): void {
  if (password.length === 0) throw new BusinessRuleError('invalid', 'Password is required')
}

export function assertCommunityAdminChange(current: CommunityAccountRecord,
  next: Pick<CommunityAccountRecord, 'admin' | 'disabled'> | undefined, enabledAdmins: number): void {
  if (current.admin && !current.disabled && (next?.admin !== true || next.disabled) && enabledAdmins <= 1) {
    throw new BusinessRuleError('conflict', 'At least one enabled administrator is required')
  }
}

export function validatedCommunityAccountInput(input: CommunityCreateAccountInput): CommunityCreateAccountInput {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(input.username)) throw new BusinessRuleError('invalid', 'Username must use lowercase letters, digits, underscores or hyphens')
  const email = input.email.trim()
  validateCommunityPassword(input.password)
  return { username: input.username, email, password: input.password }
}
import { BusinessRuleError } from './business-error.js'
