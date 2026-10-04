import type { CommunityAccountActionRequest } from '../domain/admin-contract.js'
import type { CommunityAccountActor, CommunityAccountRecord, CommunityCreateAccountInput } from '../domain/community-account.js'
import { CommunityAccountOperationError, CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'

/** Account changes and their owned session/instance effects. */
export class CommunityAccountAdministration {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly accounts: CommunityAccountStorePort,
    private readonly runtime: Pick<CommunityRuntimePort, 'terminate'>,
    private readonly connections: Pick<SessionRegistryPort, 'closeUser'>) {}

  execute(actor: CommunityAccountActor, username: string, input: CommunityAccountActionRequest): Promise<CommunityAccountRecord | undefined> {
    return this.schedule(async () => await this.apply(actor, username, input))
  }
  createMember(actor: CommunityAccountActor, input: CommunityCreateAccountInput): Promise<CommunityAccountRecord> {
    return this.schedule(async () => { this.assertAdmin(actor); return await this.accounts.create(input) })
  }
  private schedule<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(task)
    this.tail = operation.then(() => {}, () => {})
    return operation
  }
  private async apply(actor: CommunityAccountActor, username: string, input: CommunityAccountActionRequest) {
    this.assertAdmin(actor)
    const target = this.accounts.get(username)
    if (target === undefined) throw new BusinessRuleError('missing', 'Account was not found')
    if (input.action === 'set-admin') return await this.accounts.setAdmin(username, input.admin)
    if (input.action === 'delete') {
      await this.accounts.setDisabled(username, true)
      await this.stopInstance(username, 'delete')
      await this.accounts.delete(username)
      return undefined
    }
    if (input.action === 'set-disabled') {
      if (input.disabled) {
        await this.accounts.setDisabled(username, true)
        await this.stopInstance(username, 'disable')
      } else if (target.disabled) {
        await this.stopInstance(username, 'enable')
        await this.accounts.setDisabled(username, false)
      }
      return this.accounts.get(username)
    }
    await this.accounts.resetPassword(username, input.password)
    await this.connections.closeUser(username)
    return this.accounts.get(username)
  }
  private async stopInstance(username: string, action: 'disable' | 'enable' | 'delete'): Promise<void> {
    const outcomes = await Promise.allSettled([this.connections.closeUser(username), this.runtime.terminate(username)])
    const failures = outcomes.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) throw new CommunityAccountOperationError(action, { cause: new AggregateError(failures.map(result => result.reason)) })
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const current = this.accounts.get(actor.username)
    if (current === undefined || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required')
  }
}
