import { contributionPrefill, redactContributionDeclaration } from '../domain/contribution-checks.js'
import type { ContributionDeclaration, MemberContribution } from '../domain/member-contribution.js'
import type { ExecutionInspectionPort } from '../ports/execution-inspection.js'
import type { ExecutionDependencies } from './execution-dependencies.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { executionPreparationApproved } from '../domain/platform-execution.js'
import { executionConfiguration } from '../domain/execution-configuration.js'
import type { CommunityExecutionInput, CommunityExecutionView } from '../domain/admin-contract.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ExecutionConfigurationStorePort, ExecutionOwnersPort } from '../ports/platform-execution.js'

export class ExecutionAdministration {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly owners: ExecutionOwnersPort,
    private readonly store: Pick<ExecutionConfigurationStorePort, 'get' | 'list' | 'save' | 'revision'>, private readonly changed: () => Promise<void>, private readonly preparation?: Pick<ExecutionDependencies, 'view'> & { restart?(owner: string): void }, private readonly inspection?: ExecutionInspectionPort, private readonly dependencies?: Pick<RuntimeDependencies, 'ready'>) {}
  contributionRevision(name: string) { return this.store.revision?.(`skill:${name}`) ?? 'unsupported' }
  checkContribution(name: string, declaration: ContributionDeclaration): void {
    if (!declaration.execution) return
    const input = contributionPrefill(declaration)
    this.validate(`skill:${name}`, { ...input, enabled: input.commands.length > 0 })
  }
  contributionRemoved(name: string, declaration: ContributionDeclaration) {
    const existing = this.store.get(`skill:${name}`)
    return { commands: existing?.commands.filter(row => !declaration.execution?.commands.some(next => next.command === row.command)).map(row => row.command) ?? [], variables: existing?.variables.filter(row => !declaration.execution?.variables.some(next => next.name === row.name)).map(row => row.name) ?? [] }
  }
  contributionPreview(name: string, declaration: ContributionDeclaration): CommunityExecutionView {
    const existing = this.store.get(`skill:${name}`)
    const previous = existing ? { enabled: existing.enabled, commands: existing.commands, ...(existing.runtimeDependencies ? { runtimeDependencies: existing.runtimeDependencies } : {}), variables: existing.variables.map(({ name, secret, value }) => ({ name, secret, configured: !!value, ...(!secret ? { value } : {}) })) } : undefined
    const next = contributionPrefill(declaration, previous)
    return { ...next, variables: next.variables.map(row => ({ ...row, configured: previous?.variables.find(old => old.name === row.name)?.configured ?? false })) }
  }
  checkAdoption(row: MemberContribution, input?: CommunityExecutionInput, expectedRevision?: string): void {
    if (expectedRevision !== undefined && expectedRevision !== this.contributionRevision(row.name)) throw new BusinessRuleError('conflict', 'Review the newer execution settings.', 'skill-preview-changed')
    if (input) this.validate(`skill:${row.name}`, input)
  }
  async adoptContribution(row: MemberContribution, input?: CommunityExecutionInput, expectedRevision?: string): Promise<readonly string[]> {
    if (!row.declaration.execution && !input) return []
    const owner = `skill:${row.name}`, preview = input ?? this.contributionPreview(row.name, row.declaration)
    const previous = this.store.get(owner)
    let warning = previous?.contributionReceipt?.id === row.id && previous.contributionReceipt.revision === row.revision ? previous.contributionReceipt.warning : undefined
    if (previous?.contributionReceipt?.id !== row.id || previous.contributionReceipt.revision !== row.revision) {
      if (expectedRevision !== undefined && expectedRevision !== this.contributionRevision(row.name)) {
        warning = 'Execution settings changed during adoption. The newer administrator configuration was retained; review the new skill configuration.'
        this.store.save(owner, { ...(previous ?? { enabled: false, commands: [], variables: [] }), contributionReceipt: { id: row.id, revision: row.revision, warning }, awaitingPreparation: true })
        await this.changed(); return [warning]
      }
      let value
      try { value = this.validate(owner, preview) }
      catch (error) {
        if (!(error instanceof BusinessRuleError) || error.code !== 'execution-config-invalid') throw error
        // A competing administrator may claim a command while the library is being confirmed.
        // Retain the valid configuration disabled so the adopted copy remains reviewable and recoverable.
        value = this.validate(owner, { ...preview, enabled: false })
        warning = 'Execution remains disabled because a delegated command was assigned elsewhere during adoption. Review the execution settings before enabling it.'
      }
      this.store.save(owner, { ...value, contributionReceipt: { id: row.id, revision: row.revision, ...(warning ? { warning } : {}) }, awaitingPreparation: true })
    }
    await this.changed()
    return warning ? [warning] : []
  }
  private validate(owner: string, input: CommunityExecutionInput) {
    const { prepare, ...definition } = input; void prepare
    const previous = this.store.get(owner)
    const value = executionConfiguration({ ...definition, ...(previous?.prepare ? { prepare: previous.prepare } : {}) }, previous)
    this.dependencies?.ready((value.runtimeDependencies ?? []).filter(name => !this.store.get(owner)?.runtimeDependencies?.includes(name)))
    if (value.enabled && this.store.list().some(row => row.owner !== owner && row.configuration.enabled && this.owners.get(row.owner)
      && row.configuration.commands.some(command => !command.command.includes('/') && value.commands.some(next => next.command === command.command))))
      throw new BusinessRuleError('invalid', 'A command name is already delegated by another owner.', 'execution-config-invalid')
    return value
  }
  async view(actor: CommunityAccountActor, owner: string): Promise<CommunityExecutionView> {
    this.assertAdmin(actor, owner)
    const current = this.owners.get(owner)!
    const suggestions = this.inspection ? await this.inspection.inspect(current.version) : undefined
    const value = this.store.get(owner) ?? { enabled: false, commands: suggestions?.commands.map(command => ({ command, blocked: [] })) ?? [], variables: suggestions?.variables.map(name => ({ name, value: '', secret: true })) ?? [] }
    const unavailable = this.inspection ? (await Promise.all(value.commands.map(async row => await this.inspection!.available(current.version, row.command) ? [] : [row.command]))).flat() : []
    const preparation = this.preparation?.view(owner)
    const { contributionReceipt, approvedContribution, prepare, ...display } = value as typeof value & { contributionReceipt?: unknown }
    void contributionReceipt; void approvedContribution; void prepare
    const result = { ...display, ...(!executionPreparationApproved(current, value) ? { awaitingPreparation: true } : {}), ...(unavailable.length ? { unavailableCommands: unavailable } : {}), ...(preparation ? { preparation: { usable: preparation.usable, ...(preparation.usingPrevious ? { usingPrevious: true } : {}), stage: preparation.stage, updatedAt: preparation.updatedAt, log: preparation.log } } : {}), variables: value.variables.map(({ name, value, secret }) => ({ name, secret, configured: value.length > 0, ...(!secret ? { value } : {}) })) }
    return contributionReceipt ? redactContributionDeclaration(result) : result
  }
  async save(actor: CommunityAccountActor, owner: string, input: CommunityExecutionInput): Promise<CommunityExecutionView> {
    this.assertAdmin(actor, owner)
    if (input.prepare !== undefined) throw new BusinessRuleError('invalid', 'Select runtime dependencies instead of an execution preparation command.', 'execution-config-invalid')
    const value = this.validate(owner, input)
    this.store.save(owner, value); await this.changed(); return this.view(actor, owner)
  }
  async reprepare(actor: CommunityAccountActor, owner: string): Promise<CommunityExecutionView> {
    this.assertAdmin(actor, owner)
    if (!this.store.get(owner)?.enabled) throw new BusinessRuleError('invalid', 'Enable execution before preparation.', 'execution-config-invalid')
    const configuration = this.store.get(owner)!
    this.store.save(owner, { ...configuration, awaitingPreparation: false, ...(this.owners.get(owner)!.preparationApproval ? { approvedContribution: this.owners.get(owner)!.preparationApproval } : {}) })
    this.preparation?.restart?.(owner); await this.changed(); return this.view(actor, owner)
  }
  private assertAdmin(actor: CommunityAccountActor, owner: string): void {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
    if (!this.owners.get(owner)) throw new BusinessRuleError('missing', 'Execution owner is unavailable', 'skill-unavailable')
  }
}
