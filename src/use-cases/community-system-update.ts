import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { CommunitySystemUpdatePort } from '../ports/community-system-update.js'
import type { CommunitySystemUpdateStatus, CommunitySystemUpdateAction, CommunitySystemUpdateCheckResult, CommunitySystemUpdateSubmission } from '../domain/admin-contract.js'

/** Admits fresh administrators to the independently owned update transaction. */
export class CommunitySystemUpdate {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly updater: CommunitySystemUpdatePort) {}
  async status(actor: CommunityAccountActor, operation?: string): Promise<CommunitySystemUpdateStatus> {
    this.assertAdmin(actor)
    if (operation !== undefined) this.assertOperation(operation)
    return await this.updater.status(operation)
  }
  execute(actor: CommunityAccountActor, input: Extract<CommunitySystemUpdateAction, { action: 'check' }>): Promise<CommunitySystemUpdateCheckResult>
  execute(actor: CommunityAccountActor, input: Exclude<CommunitySystemUpdateAction, { action: 'check' }>): Promise<CommunitySystemUpdateSubmission>
  execute(actor: CommunityAccountActor, input: CommunitySystemUpdateAction): Promise<CommunitySystemUpdateCheckResult | CommunitySystemUpdateSubmission>
  async execute(actor: CommunityAccountActor, input: CommunitySystemUpdateAction): Promise<CommunitySystemUpdateCheckResult | CommunitySystemUpdateSubmission> {
    this.assertAdmin(actor)
    if (input.action === 'check') return await this.updater.check()
    if (input.action === 'prepare') {
      if (typeof input.version !== 'string' || !/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(input.version)
        || typeof input.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.manifestSha256))
        throw new BusinessRuleError('invalid', 'Choose the verified formal release from Check for updates.', 'update-release-required')
      return await this.updater.prepare(input.version, input.manifestSha256)
    }
    if (input.action !== 'apply' || input.confirmed !== true) throw new BusinessRuleError('invalid', 'Confirm service restart, interruption of all running tasks and unsaved work risk.', 'update-confirmation-required')
    this.assertOperation(input.operation)
    return await this.updater.apply(input.operation)
  }
  private assertOperation(operation: string): void {
    if (typeof operation !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(operation))
      throw new BusinessRuleError('invalid', 'Choose the exact verified update operation.', 'update-operation-required')
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const current = this.accounts.get(actor.username)
    if (current === undefined || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
