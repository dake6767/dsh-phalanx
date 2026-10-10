import type { PluginGrantsPort } from '../ports/managed-plugins.js'
import type { CommunityAccountActionRequest, CommunityGroupAction } from '../domain/admin-contract.js'
import type { CommunityAccountActor, CommunityAccountRecord, CommunityCreateAccountInput } from '../domain/community-account.js'
import { assertCommunityAdminChange, CommunityAccountOperationError, CommunityAuthenticationError } from '../domain/community-account.js'
import { assertCommunityGroupRole, assertGroupDeletion, assertOrdinaryGroup, requiredCommunityGroup, validatedGroupName } from '../domain/community-group.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'

/** Account changes and their owned session/instance effects. */
export class CommunityAccountAdministration {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly accounts: CommunityAccountStorePort,
    private readonly runtime: Pick<CommunityRuntimePort, 'terminate'>,
    private readonly connections: Pick<SessionRegistryPort, 'closeUser'>, private readonly grants?: Pick<PluginGrantsPort, 'remove'>, private readonly changed?: () => Promise<void>) {}

  execute(actor: CommunityAccountActor, username: string, input: CommunityAccountActionRequest): Promise<CommunityAccountRecord | undefined> {
    return this.schedule(async () => await this.apply(actor, username, input))
  }
  createMember(actor: CommunityAccountActor, input: CommunityCreateAccountInput): Promise<CommunityAccountRecord> {
    return this.schedule(async () => {
      this.assertAdmin(actor)
      const groups = this.accounts.listGroups()
      const group = requiredCommunityGroup(groups, input.groupId ?? groups.find(value => value.isDefault)!.id)
      assertCommunityGroupRole(group, false)
      return await this.accounts.create({ ...input, groupId: group.id })
    })
  }
  listGroups(actor: CommunityAccountActor) { this.assertAdmin(actor); return this.accounts.listGroups() }
  manageGroup(actor: CommunityAccountActor, input: CommunityGroupAction) {
    return this.schedule(async () => {
      this.assertAdmin(actor)
      const groups = this.accounts.listGroups()
      if (input.action === 'create') this.accounts.createGroup(validatedGroupName(groups, input.name))
      else {
        const group = requiredCommunityGroup(groups, input.id)
        if (input.action === 'rename') this.accounts.renameGroup(group.id, validatedGroupName(groups, input.name, group.id))
        if (input.action === 'delete') { assertGroupDeletion(group); this.accounts.deleteGroup(group.id); this.grants?.remove(group.id) }
        if (input.action === 'set-default') { assertOrdinaryGroup(group); this.accounts.setDefaultGroup(group.id) }
      }
      return this.accounts.listGroups()
    })
  }
  private schedule<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(async () => { try { return await task() } finally { await this.changed?.() } })
    this.tail = operation.then(() => {}, () => {})
    return operation
  }
  private async apply(actor: CommunityAccountActor, username: string, input: CommunityAccountActionRequest) {
    this.assertAdmin(actor)
    const target = this.accounts.get(username)
    if (target === undefined) throw new BusinessRuleError('missing', 'Account was not found', 'account-not-found')
    if (input.action === 'set-email') {
      const groupId = input.groupId ?? target.groupId
      assertCommunityGroupRole(requiredCommunityGroup(this.accounts.listGroups(), groupId), target.admin)
      return await this.accounts.setAccountDetails(username, input.email, groupId)
    }
    if (input.action === 'set-admin') {
      assertCommunityAdminChange(target, { admin: input.admin, disabled: target.disabled }, this.accounts.list().filter(account => account.admin && !account.disabled).length)
      if (!input.admin && input.groupId === undefined) throw new BusinessRuleError('invalid', 'Select a target group', 'group-required')
      const groupId = input.admin ? this.accounts.listGroups().find(group => group.kind === 'admin')!.id : input.groupId!
      assertCommunityGroupRole(requiredCommunityGroup(this.accounts.listGroups(), groupId), input.admin)
      return await this.accounts.setAdmin(username, input.admin, groupId)
    }
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
    if (current === undefined || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
