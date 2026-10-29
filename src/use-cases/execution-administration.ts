import type { CommunityExecutionInput, CommunityExecutionView } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { contributionPrefill, redactContributionDeclaration } from '../domain/contribution-checks.js'
import { executionConfiguration } from '../domain/execution-configuration.js'
import type { ContributionDeclaration, MemberContribution } from '../domain/member-contribution.js'
import type { ExecutionConfiguration, SuiteExecutionTemplate } from '../domain/platform-execution.js'
import { executionPreparationApproved, suiteExecutionReady } from '../domain/platform-execution.js'
import { invalidRequest } from '../domain/suite-catalog.js'
import type { SuiteExecutionSnapshot } from '../domain/suite-install.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ExecutionInspectionPort } from '../ports/execution-inspection.js'
import type { ExecutionConfigurationStorePort, ExecutionOwnersPort } from '../ports/platform-execution.js'
import type { PlatformUnitOfWorkPort } from '../ports/platform-unit-of-work.js'
import type { ExecutionDependencies } from './execution-dependencies.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'

const variableView = ({ name, value, secret }: ExecutionConfiguration['variables'][number]): CommunityExecutionView['variables'][number] => ({
  name,
  secret,
  configured: !!value,
  ...(secret ? { last4: value.slice(-4) } : { value }),
})

export class ExecutionAdministration {
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly owners: ExecutionOwnersPort,
    private readonly store: Pick<ExecutionConfigurationStorePort, 'get' | 'list' | 'save' | 'revision' | 'remove'>,
    private readonly changed: () => Promise<void>,
    private readonly preparation?: Pick<ExecutionDependencies, 'view'> & { restart?(owner: string): void },
    private readonly inspection?: ExecutionInspectionPort,
    private readonly dependencies?: Pick<RuntimeDependencies, 'readReady'>,
    private readonly work?: PlatformUnitOfWorkPort<{ execution: ExecutionConfigurationStorePort }>,
  ) {}
  async contributionRevision(name: string) {
    return this.store.revision ? await this.store.revision(`skill:${name}`) : 'unsupported'
  }
  async checkContribution(name: string, declaration: ContributionDeclaration): Promise<void> {
    if (!declaration.execution) return
    const input = contributionPrefill(declaration)
    await this.validate(`skill:${name}`, { ...input, enabled: input.commands.length > 0 })
  }
  async contributionRemoved(name: string, declaration: ContributionDeclaration) {
    const existing = await this.store.get(`skill:${name}`)
    return {
      commands: existing?.commands.filter(row => !declaration.execution?.commands.some(next => next.command === row.command)).map(row => row.command) ?? [],
      variables: existing?.variables.filter(row => !declaration.execution?.variables.some(next => next.name === row.name)).map(row => row.name) ?? [],
    }
  }
  async contributionPreview(name: string, declaration: ContributionDeclaration): Promise<CommunityExecutionView> {
    const existing = await this.store.get(`skill:${name}`)
    const previous = existing
      ? {
          enabled: existing.enabled,
          commands: existing.commands,
          ...(existing.runtimeDependencies ? { runtimeDependencies: existing.runtimeDependencies } : {}),
          variables: existing.variables.map(variableView),
        }
      : undefined
    const next = contributionPrefill(declaration, previous)
    return {
      ...next,
      variables: next.variables.map(row => ({
        ...row,
        configured: previous?.variables.find(old => old.name === row.name)?.configured ?? false,
        ...(row.secret ? { last4: previous?.variables.find(old => old.name === row.name)?.last4 ?? '' } : {}),
      })),
    }
  }
  async checkAdoption(row: MemberContribution, input?: CommunityExecutionInput, expectedRevision?: string): Promise<void> {
    if (expectedRevision !== undefined && expectedRevision !== (await this.contributionRevision(row.name)))
      throw new BusinessRuleError('conflict', 'Review the newer execution settings.', 'skill-preview-changed')
    if (input) await this.validate(`skill:${row.name}`, input)
  }
  async adoptContribution(row: MemberContribution, input?: CommunityExecutionInput, expectedRevision?: string): Promise<readonly string[]> {
    if (!row.declaration.execution && !input) return []
    const owner = `skill:${row.name}`,
      preview = input ?? (await this.contributionPreview(row.name, row.declaration))
    const previous = await this.store.get(owner)
    let warning =
      previous?.contributionReceipt?.id === row.id && previous.contributionReceipt.revision === row.revision ? previous.contributionReceipt.warning : undefined
    if (previous?.contributionReceipt?.id !== row.id || previous.contributionReceipt.revision !== row.revision) {
      if (expectedRevision !== undefined && expectedRevision !== (await this.contributionRevision(row.name))) {
        warning = 'Execution settings changed during adoption. The newer administrator configuration was retained; review the new skill configuration.'
        await this.store.save(owner, {
          ...(previous ?? { enabled: false, commands: [], variables: [] }),
          contributionReceipt: { id: row.id, revision: row.revision, warning },
          awaitingPreparation: true,
        })
        await this.changed()
        return [warning]
      }
      let value
      try {
        value = await this.validate(owner, preview)
      } catch (error) {
        if (!(error instanceof BusinessRuleError) || error.code !== 'execution-config-invalid') throw error
        // A competing administrator may claim a command while the library is being confirmed.
        // Retain the valid configuration disabled so the adopted copy remains reviewable and recoverable.
        value = await this.validate(owner, { ...preview, enabled: false })
        warning =
          'Execution remains disabled because a delegated command was assigned elsewhere during adoption. Review the execution settings before enabling it.'
      }
      await this.store.save(owner, {
        ...value,
        contributionReceipt: { id: row.id, revision: row.revision, ...(warning ? { warning } : {}) },
        awaitingPreparation: true,
      })
    }
    await this.changed()
    return warning ? [warning] : []
  }
  /** Suite installs write a locked configuration that stays disabled until every declared variable has a value.
   * `replacing` holds the manual configurations the confirmed preview recorded; any change since then refuses the takeover. */
  async commitSuiteExecution(
    origin: string,
    owner: string,
    template: SuiteExecutionTemplate,
    credentials: Readonly<Record<string, string>>,
    replacing: readonly SuiteExecutionSnapshot[] = [],
  ): Promise<void> {
    if (this.work) return this.atomic(scoped => scoped.commitSuiteExecution(origin, owner, template, credentials, replacing))
    if (!this.owners.get(owner)) throw new BusinessRuleError('missing', 'Execution owner is unavailable', 'skill-unavailable')
    const currentRows = new Map((await this.store.list()).map(row => [row.owner, row.configuration]))
    const manual = (name: string) => {
      const row = currentRows.get(name)
      return row && !row.suiteOrigin ? row : undefined
    }
    // A recorded configuration that is gone counts as changed, so a later failure cannot bring it back.
    for (const name of new Set([owner, ...replacing.map(row => row.owner)]))
      if (
        (manual(name) || (replacing.some(row => row.owner === name) && currentRows.get(name)?.suiteOrigin !== origin)) &&
        JSON.stringify(await this.suiteExecutionSnapshot(name)) !== JSON.stringify(replacing.find(row => row.owner === name))
      )
        throw new BusinessRuleError('conflict', 'The manual entries changed after the preview. Review the install again.', 'suite-replace-unconfirmed')
    // Configurations of other replaced skills delegating the same commands are taken over too. They stay, disabled, under
    // this install until it settles so a failure restores them; finalizeSuiteExecutions then removes them.
    const commands = new Set(template.commands.map(row => row.command)),
      kept = manual(owner)
    const others = replacing.flatMap(row => {
      const config = row.owner !== owner ? manual(row.owner) : undefined
      return config?.commands.some(next => commands.has(next.command)) ? [{ owner: row.owner, config }] : []
    })
    for (const other of others) await this.store.save(other.owner, { ...other.config, enabled: false, suiteOrigin: origin })
    // Rollback removes the configuration, so a retried install starts from the wizard's values; replaced manual
    // configurations contribute the credentials they already saved.
    const saved = (name: string) =>
      [kept, ...others.map(row => row.config)].map(config => config?.variables.find(row => row.name === name)?.value).find(value => value)
    const variables = template.variables.map(name => ({ name, secret: true, value: credentials[name] ?? saved(name) ?? '' }))
    // Variables only the manual configuration declared also stay until the install settles; the delegated command
    // already received them before the takeover.
    const extra = kept?.variables.filter(row => !template.variables.includes(row.name) && row.value !== '') ?? []
    await this.saveSuite(
      owner,
      { commands: template.commands, variables, runtimeDependencies: template.runtimeDependencies, optionalVariables: template.optionalVariables ?? [] },
      origin,
      undefined,
      extra,
    )
  }
  /** Snapshot of a suite-owned configuration, so an update can put it back. */
  async suiteOwnedSnapshot(origin: string, owner: string): Promise<SuiteExecutionSnapshot | undefined> {
    const current = await this.store.get(owner)
    if (current?.suiteOrigin !== origin) return undefined
    return {
      owner,
      enabled: current.enabled,
      ...(current.optionalVariables ? { optionalVariables: [...current.optionalVariables] } : {}),
      commands: current.commands.map(row => ({ ...row, blocked: [...row.blocked] })),
      runtimeDependencies: [...(current.runtimeDependencies ?? [])],
      variables: current.variables.map(row => ({ name: row.name, secret: row.secret, hadValue: row.value !== '' })),
    }
  }
  /** Applies a new version's commands and variables; saved values are kept, new variables stay empty and so keep execution off. */
  async updateSuiteExecution(origin: string, owner: string, template: SuiteExecutionTemplate): Promise<void> {
    const current = await this.store.get(owner)
    if (current?.suiteOrigin !== origin) throw new BusinessRuleError('conflict', 'The suite execution is no longer part of the suite.', 'suite-entry-missing')
    const variables = template.variables.map(name => ({ name, secret: true, value: current.variables.find(row => row.name === name)?.value ?? '' }))
    // Values of variables the new version dropped stay until the update settles, so a failure can restore them.
    const dropped = current.variables.filter(row => !template.variables.includes(row.name) && row.value !== '')
    const enabled = current.enabled && suiteExecutionReady(variables, template.optionalVariables)
    const configuration = await this.validate(
      owner,
      {
        enabled,
        commands: template.commands.map(row => ({ ...row, blocked: [...row.blocked] })),
        variables,
        optionalVariables: template.optionalVariables ?? [],
        runtimeDependencies: [...template.runtimeDependencies],
      },
      current,
    )
    await this.store.save(owner, { ...configuration, variables: [...configuration.variables, ...dropped], suiteOrigin: origin })
    return this.changed()
  }
  /** Puts a suite configuration back as an update found it; the values it held are still in the store. */
  async restoreSuiteUpdate(origin: string, snapshot: SuiteExecutionSnapshot): Promise<void> {
    const current = await this.store.get(snapshot.owner)
    if (current && current.suiteOrigin !== origin) return
    const value = (name: string) => current?.variables.find(row => row.name === name)?.value ?? ''
    const variables = snapshot.variables.map(row => ({ name: row.name, secret: row.secret, value: row.hadValue ? value(row.name) : '' }))
    await this.store.save(
      snapshot.owner,
      {
        enabled: snapshot.enabled && suiteExecutionReady(variables, snapshot.optionalVariables),
        ...(snapshot.optionalVariables ? { optionalVariables: snapshot.optionalVariables } : {}),
        commands: snapshot.commands,
        variables,
        ...(snapshot.runtimeDependencies.length ? { runtimeDependencies: snapshot.runtimeDependencies } : {}),
        suiteOrigin: origin,
      },
      current?.rowRevision ?? 'none',
    )
    await this.changed()
  }
  /** Once an install that took over manual configurations succeeded, only the suite's own configurations and variables remain. */
  async finalizeSuiteExecutions(origin: string, keep: readonly { readonly owner: string; readonly variables: readonly string[] }[]): Promise<void> {
    if (this.work) return this.atomic(scoped => scoped.finalizeSuiteExecutions(origin, keep))
    const rows = (await this.store.list()).filter(row => row.configuration.suiteOrigin === origin)
    for (const row of rows) {
      const variables = keep.find(next => next.owner === row.owner)?.variables
      if (variables && row.configuration.variables.some(next => !variables.includes(next.name)))
        await this.store.save(row.owner, { ...row.configuration, variables: row.configuration.variables.filter(next => variables.includes(next.name)) })
    }
    for (const row of rows) if (!keep.some(next => next.owner === row.owner)) await this.store.remove(row.owner, row.configuration.rowRevision)
    await this.changed()
  }
  /** Blank values keep the saved credential; execution turns on once every variable is configured. */
  async saveSuiteCredentials(origin: string, owner: string, credentials: Readonly<Record<string, string>>): Promise<void> {
    const current = await this.store.get(owner)
    if (!current || current.suiteOrigin !== origin) throw new BusinessRuleError('missing', 'This catalog entry is not installed.', 'suite-not-installed')
    if (Object.keys(credentials).some(name => !current.variables.some(row => row.name === name))) throw invalidRequest()
    const variables = current.variables.map(row => ({ name: row.name, secret: row.secret, value: credentials[row.name] ?? row.value }))
    await this.saveSuite(
      owner,
      { commands: current.commands, variables, runtimeDependencies: current.runtimeDependencies ?? [], optionalVariables: current.optionalVariables ?? [] },
      origin,
      current,
    )
  }
  async removeSuiteExecution(origin: string): Promise<void> {
    if (this.work) return this.atomic(scoped => scoped.removeSuiteExecution(origin))
    const rows = await this.store.list()
    if (!rows.some(row => row.configuration.suiteOrigin === origin)) return
    for (const row of rows) if (row.configuration.suiteOrigin === origin) await this.store.remove(row.owner, row.configuration.rowRevision)
    await this.changed()
  }
  /** Detaching keeps commands, saved credentials and the enabled state; the execution page can then edit it. */
  async detachSuiteExecution(origin: string, owner: string): Promise<void> {
    const current = await this.store.get(owner)
    if (!current || current.suiteOrigin !== origin) return
    const { suiteOrigin, ...detached } = current
    void suiteOrigin
    await this.store.save(owner, detached)
    await this.changed()
  }
  /** What a takeover needs to put a manual configuration back; secret values stay in this store. */
  async suiteExecutionSnapshot(owner: string): Promise<SuiteExecutionSnapshot | undefined> {
    const current = await this.store.get(owner)
    if (!current || current.suiteOrigin) return undefined
    return {
      owner,
      enabled: current.enabled,
      ...(current.optionalVariables ? { optionalVariables: [...current.optionalVariables] } : {}),
      commands: current.commands.map(row => ({ ...row, blocked: [...row.blocked] })),
      runtimeDependencies: [...(current.runtimeDependencies ?? [])],
      variables: current.variables.map(row => ({ name: row.name, secret: row.secret, hadValue: row.value !== '' })),
      ...(current.approvedContribution !== undefined ? { approvedContribution: current.approvedContribution } : {}),
      ...(current.contributionReceipt ? { contributionReceipt: structuredClone(current.contributionReceipt) } : {}),
      ...(current.awaitingPreparation !== undefined ? { awaitingPreparation: current.awaitingPreparation } : {}),
    }
  }
  /** Restores a manual configuration a failed takeover replaced, reusing values the suite configuration still holds.
   * Only a configuration this install owns is restored; before the commit the manual one was never touched. */
  async restoreSuiteExecution(origin: string, snapshot: SuiteExecutionSnapshot): Promise<void> {
    const current = await this.store.get(snapshot.owner)
    if (current?.suiteOrigin !== origin) return
    const variables = snapshot.variables.map(row => ({
      name: row.name,
      secret: row.secret,
      value: row.hadValue ? (current?.variables.find(next => next.name === row.name)?.value ?? '') : '',
    }))
    // Re-enable only when every value the original held is available again; a missing one leaves it off for review.
    const complete = snapshot.variables.every(row => !row.hadValue || variables.find(next => next.name === row.name)?.value !== '')
    await this.store.save(
      snapshot.owner,
      {
        enabled: snapshot.enabled && complete,
        ...(snapshot.optionalVariables ? { optionalVariables: snapshot.optionalVariables } : {}),
        commands: snapshot.commands,
        variables,
        ...(snapshot.runtimeDependencies.length ? { runtimeDependencies: snapshot.runtimeDependencies } : {}),
        ...(snapshot.approvedContribution !== undefined ? { approvedContribution: snapshot.approvedContribution } : {}),
        ...(snapshot.contributionReceipt ? { contributionReceipt: snapshot.contributionReceipt } : {}),
        ...(snapshot.awaitingPreparation !== undefined ? { awaitingPreparation: snapshot.awaitingPreparation } : {}),
      },
      current.rowRevision,
    )
    await this.changed()
  }
  /** Non-secret catalog status, including optional settings which are still unconfigured. */
  async suiteExecutionStatus(owner: string) {
    const current = await this.store.get(owner)
    return {
      enabled: current?.enabled ?? false,
      configuredVariables: current?.variables.filter(row => row.value !== '').map(row => row.name) ?? [],
      missingCredentials: current?.variables.filter(row => row.value === '' && !current.optionalVariables?.includes(row.name)).map(row => row.name) ?? [],
    }
  }
  /** Required variables of a suite configuration that still have no value. */
  async suiteMissingCredentials(owner: string): Promise<readonly string[]> {
    return (await this.suiteExecutionStatus(owner)).missingCredentials
  }
  /** Delegated command names another enabled owner already holds; such a suite could never be enabled. */
  async delegatedCommandConflicts(owner: string, commands: readonly string[], replacing: readonly string[] = []): Promise<readonly string[]> {
    const rows = await this.store.list()
    return commands.filter(command =>
      rows.some(
        row =>
          row.owner !== owner &&
          !replacing.includes(row.owner) &&
          row.configuration.enabled &&
          this.owners.get(row.owner) &&
          row.configuration.commands.some(next => next.command === command),
      ),
    )
  }
  private async saveSuite(
    owner: string,
    value: {
      readonly commands: SuiteExecutionTemplate['commands']
      readonly variables: readonly { name: string; secret: boolean; value: string }[]
      readonly runtimeDependencies: readonly string[]
      readonly optionalVariables?: readonly string[]
    },
    origin: string,
    previous?: ExecutionConfiguration,
    retainedVariables: ExecutionConfiguration['variables'] = [],
  ) {
    const configuration = await this.validate(
      owner,
      {
        enabled: suiteExecutionReady(value.variables, value.optionalVariables),
        optionalVariables: value.optionalVariables ?? [],
        commands: value.commands.map(row => ({ ...row, blocked: [...row.blocked] })),
        variables: [...value.variables],
        runtimeDependencies: [...value.runtimeDependencies],
      },
      previous,
    )
    await this.store.save(owner, { ...configuration, variables: [...configuration.variables, ...retainedVariables], suiteOrigin: origin })
    await this.changed()
  }
  private async validate(owner: string, input: CommunityExecutionInput, previous?: ExecutionConfiguration) {
    previous ??= await this.store.get(owner)
    const { prepare, ...definition } = input
    void prepare
    const value = executionConfiguration(definition, previous)
    await this.dependencies?.readReady((value.runtimeDependencies ?? []).filter(name => !previous?.runtimeDependencies?.includes(name)))
    if (
      value.enabled &&
      (await this.store.list()).some(
        row =>
          row.owner !== owner &&
          row.configuration.enabled &&
          this.owners.get(row.owner) &&
          row.configuration.commands.some(command => !command.command.includes('/') && value.commands.some(next => next.command === command.command)),
      )
    )
      throw new BusinessRuleError('invalid', 'A command name is already delegated by another owner.', 'execution-config-invalid')
    return value
  }
  async view(actor: CommunityAccountActor, owner: string): Promise<CommunityExecutionView> {
    await this.assertAdmin(actor, owner)
    const current = this.owners.get(owner)!
    const suggestions = this.inspection ? await this.inspection.inspect(current.version) : undefined
    const value: ExecutionConfiguration = (await this.store.get(owner)) ?? {
      enabled: false,
      commands: suggestions?.commands.map(command => ({ command, blocked: [] })) ?? [],
      variables: suggestions?.variables.map(name => ({ name, value: '', secret: true })) ?? [],
    }
    const unavailable = this.inspection
      ? (
          await Promise.all(
            value.commands.map(async row => ((await this.inspection!.available(current.version, row.source ?? row.command)) ? [] : [row.command])),
          )
        ).flat()
      : []
    const preparation = await this.preparation?.view(owner)
    const { contributionReceipt, approvedContribution, rowRevision, ...display } = value as typeof value & { contributionReceipt?: unknown }
    void contributionReceipt
    void approvedContribution
    void rowRevision
    const result = {
      ...display,
      ...(!executionPreparationApproved(current, value) ? { awaitingPreparation: true } : {}),
      ...(unavailable.length ? { unavailableCommands: unavailable } : {}),
      ...(preparation
        ? {
            preparation: {
              usable: preparation.usable,
              identity: preparation.identity,
              stage: preparation.stage,
              updatedAt: preparation.updatedAt,
              log: preparation.log,
            },
          }
        : {}),
      variables: value.variables.map(variableView),
    }
    return contributionReceipt ? redactContributionDeclaration(result) : result
  }
  async save(actor: CommunityAccountActor, owner: string, input: CommunityExecutionInput): Promise<CommunityExecutionView> {
    await this.assertAdmin(actor, owner)
    await this.assertUnlocked(owner)
    if (input.prepare !== undefined)
      throw new BusinessRuleError('invalid', 'Select runtime dependencies instead of an execution preparation command.', 'execution-config-invalid')
    const value = await this.validate(owner, input)
    await this.store.save(owner, value)
    await this.changed()
    return this.view(actor, owner)
  }
  async reprepare(actor: CommunityAccountActor, owner: string): Promise<CommunityExecutionView> {
    await this.assertAdmin(actor, owner)
    await this.assertUnlocked(owner)
    const configuration = await this.store.get(owner)
    if (!configuration?.enabled) throw new BusinessRuleError('invalid', 'Enable execution before preparation.', 'execution-config-invalid')
    await this.store.save(owner, {
      ...configuration,
      awaitingPreparation: false,
      ...(this.owners.get(owner)!.preparationApproval ? { approvedContribution: this.owners.get(owner)!.preparationApproval } : {}),
    })
    this.preparation?.restart?.(owner)
    await this.changed()
    return this.view(actor, owner)
  }
  private async atomic(operation: (scoped: ExecutionAdministration) => Promise<void>): Promise<void> {
    await this.work!.run(async rows =>
      operation(new ExecutionAdministration(this.accounts, this.owners, rows.execution, async () => {}, this.preparation, this.inspection, this.dependencies)),
    )
    await this.changed()
  }
  private async assertUnlocked(owner: string): Promise<void> {
    if ((await this.store.get(owner))?.suiteOrigin)
      throw new BusinessRuleError('forbidden', 'Suite catalog entries are read-only. Uninstall the suite or detach the entry first.', 'suite-entry-locked')
  }
  private async assertAdmin(actor: CommunityAccountActor, owner: string): Promise<void> {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
    if (!this.owners.get(owner)) throw new BusinessRuleError('missing', 'Execution owner is unavailable', 'skill-unavailable')
  }
}
