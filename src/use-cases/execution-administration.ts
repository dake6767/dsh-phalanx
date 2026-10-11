import type { ExecutionPreparation } from './execution-preparation.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { executionConfiguration } from '../domain/execution-configuration.js'
import type { CommunityExecutionInput, CommunityExecutionView } from '../domain/admin-contract.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ExecutionConfigurationStorePort, ExecutionOwnersPort } from '../ports/platform-execution.js'

export class ExecutionAdministration {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly owners: ExecutionOwnersPort,
    private readonly store: ExecutionConfigurationStorePort, private readonly changed: () => Promise<void>, private readonly preparation?: Pick<ExecutionPreparation, 'view' | 'restart'>) {}
  view(actor: CommunityAccountActor, owner: string): CommunityExecutionView {
    this.assertAdmin(actor, owner)
    const value = this.store.get(owner) ?? { enabled: false, commands: [], variables: [] }
    const preparation = this.preparation?.view(owner)
    return { ...value, ...(preparation ? { preparation: { stage: preparation.stage, updatedAt: preparation.updatedAt, log: preparation.log } } : {}), variables: value.variables.map(({ name, value, secret }) => ({ name, secret, configured: value.length > 0, ...(!secret ? { value } : {}) })) }
  }
  async save(actor: CommunityAccountActor, owner: string, input: CommunityExecutionInput): Promise<CommunityExecutionView> {
    this.assertAdmin(actor, owner)
    const value = executionConfiguration(input, this.store.get(owner))
    if (value.enabled && this.store.list().some(row => row.owner !== owner && row.configuration.enabled && this.owners.get(row.owner)
      && row.configuration.commands.some(command => !command.command.includes('/') && value.commands.some(next => next.command === command.command))))
      throw new BusinessRuleError('invalid', 'A command name is already delegated by another owner.', 'execution-config-invalid')
    this.store.save(owner, value); await this.changed(); return this.view(actor, owner)
  }
  reprepare(actor: CommunityAccountActor, owner: string): CommunityExecutionView {
    this.assertAdmin(actor, owner)
    if (!this.store.get(owner)?.enabled) throw new BusinessRuleError('invalid', 'Enable execution before preparation.', 'execution-config-invalid')
    this.preparation?.restart(owner); return this.view(actor, owner)
  }
  private assertAdmin(actor: CommunityAccountActor, owner: string): void {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
    if (!this.owners.get(owner)) throw new BusinessRuleError('missing', 'Execution owner is unavailable', 'skill-unavailable')
  }
}
