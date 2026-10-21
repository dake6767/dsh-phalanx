import type { CommunityInstanceResourceApplication, CommunityInstanceResourceMember, CommunityInstanceResourceSettings, CommunityInstanceResourceTarget } from '../domain/admin-contract.js'
import type { CommunityAccountActor, CommunityAccountRecord } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { effectiveInstanceResources, instanceIdleSeconds, instanceResourceLimits, instanceResourcesApplied, suggestedInstanceResources, type InstanceResourceState } from '../domain/instance-resources.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { InstanceResourceHostPort, InstanceResourceStorePort, MemberInstanceResourcePort } from '../ports/instance-resources.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'

/** Owns target settings, current-state presentation and confirmed application transactions. */
export class InstanceResources implements MemberInstanceResourcePort {
  private pending: Promise<void> = Promise.resolve()
  private stopping = false
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list'>,
    private readonly store: InstanceResourceStorePort, private readonly host: InstanceResourceHostPort,
    private readonly runtime: Pick<CommunityRuntimePort, 'status' | 'applyResources'>,
    private readonly connections: Pick<SessionRegistryPort, 'closeUser'>, private readonly isolated: boolean,
    private readonly residents?: { settingsChanged(): void, failure(spaceId: string): { readonly at: number } | undefined }) {}

  forSpace(spaceId: string) {
    const state = this.store.read()
    return effectiveInstanceResources(state.defaults, state.overrides[spaceId])
  }
  settings(actor: CommunityAccountActor): CommunityInstanceResourceSettings {
    this.assertAdmin(actor)
    const state = this.store.read(), host = this.host.read()
    const members = this.accounts.list().map(account => ({ account, view: this.view(account, state), status: this.runtime.status(account.username) }))
    let runningMemoryMiB = 0, runningUnlimited = 0, residentMemoryMiB = 0, residentUnlimited = 0, totalMemoryMiB = 0, totalUnlimited = 0
    for (const row of members) {
      const running = row.status.state === 'ready' || row.status.state === 'draining'
      const resident = !row.account.disabled && row.view.resident
      const memory = row.view.target.memoryMiB
      if (running) { if (memory === null) runningUnlimited++; else runningMemoryMiB += memory }
      if (resident) { if (memory === null) residentUnlimited++; else residentMemoryMiB += memory }
      if (running || resident) { if (memory === null) totalUnlimited++; else totalMemoryMiB += memory }
    }
    return { idleSeconds: state.idleSeconds, revision: state.revision, defaults: state.defaults, suggested: suggestedInstanceResources(host), isolated: this.isolated,
      host: { memoryMiB: host.memoryBytes / 1024 ** 2, cpus: host.cpuCount },
      capacity: { runningMemoryMiB, residentMemoryMiB, runningUnlimited, residentUnlimited, totalMemoryMiB, totalUnlimited, overcommitted: totalMemoryMiB > host.memoryBytes / 1024 ** 2 },
      pending: members.filter(row => !row.account.disabled && row.status.state === 'ready' && row.view.pending).map(row => row.view) }
  }
  member(actor: CommunityAccountActor, username: string): CommunityInstanceResourceMember {
    this.assertAdmin(actor)
    return this.view(this.account(username), this.store.read())
  }
  saveDefaults(actor: CommunityAccountActor, input: unknown): Promise<CommunityInstanceResourceSettings> {
    return this.serial(() => {
      this.assertAdmin(actor)
      const request = record(input), state = this.fresh(request.revision), limits = instanceResourceLimits(request.limits)
      const idleSeconds = request.idleSeconds === undefined ? state.idleSeconds : instanceIdleSeconds(request.idleSeconds)
      this.store.save({ ...state, revision: state.revision + 1, defaults: limits, idleSeconds })
      this.residents?.settingsChanged()
      return this.settings(actor)
    })
  }
  saveMember(actor: CommunityAccountActor, input: unknown): Promise<CommunityInstanceResourceMember> {
    return this.serial(() => {
      this.assertAdmin(actor)
      const request = record(input), state = this.fresh(request.revision)
      if (typeof request.username !== 'string' || typeof request.spaceId !== 'string') throw invalid()
      const account = this.account(request.username)
      if (account.spaceId !== request.spaceId) throw stale()
      const overrides = { ...state.overrides }
      if (request.override === null) delete overrides[account.spaceId]
      else overrides[account.spaceId] = instanceResourceLimits(request.override)
      const residents = { ...state.residents }
      if (request.resident !== undefined) {
        if (typeof request.resident !== 'boolean') throw invalid()
        if (request.resident) residents[account.spaceId] = true
        else delete residents[account.spaceId]
      }
      this.store.save({ ...state, revision: state.revision + 1, overrides, residents })
      this.residents?.settingsChanged()
      return this.member(actor, account.username)
    })
  }
  apply(actor: CommunityAccountActor, input: unknown, origin: URL): Promise<CommunityInstanceResourceApplication> {
    return this.serial(async () => {
      this.assertAdmin(actor)
      const request = record(input), state = this.fresh(request.revision)
      if (!this.isolated) throw new BusinessRuleError('conflict', 'Resource limits do not apply in development mode.', 'instance-resource-development')
      if (request.confirmed !== true) throw new BusinessRuleError('invalid', 'Confirm applying resource limits.', 'instance-resource-confirmation-required')
      if (!Array.isArray(request.targets)) throw invalid()
      const targets = request.targets.map(value => {
        const row = record(value)
        if (typeof row.username !== 'string' || typeof row.spaceId !== 'string' || typeof row.instanceKey !== 'string' || !row.instanceKey) throw invalid()
        return row as unknown as CommunityInstanceResourceTarget
      })
      if (new Set(targets.map(row => row.username)).size !== targets.length) throw invalid()
      const results: CommunityInstanceResourceApplication['results'][number][] = []
      for (const target of targets) {
        this.assertAdmin(actor); this.fresh(state.revision)
        const account = this.accounts.get(target.username), current = this.runtime.status(target.username)
        if (!account || account.disabled || account.spaceId !== target.spaceId || current.state !== 'ready' || current.instance.resourceKey !== target.instanceKey) {
          results.push({ username: target.username, status: 'changed' }); continue
        }
        const limits = effectiveInstanceResources(state.defaults, state.overrides[account.spaceId])
        try {
          if (!this.runtime.applyResources) throw new Error('Resource application is unavailable')
          const assertCurrent = () => {
            this.assertAdmin(actor); this.fresh(state.revision)
            const member = this.accounts.get(target.username)
            if (!member || member.disabled || member.spaceId !== target.spaceId) throw stale()
          }
          const applied = await this.runtime.applyResources(current.instance, limits, origin.href,
            async () => { assertCurrent(); await this.connections.closeUser(target.username) }, assertCurrent)
          this.assertAdmin(actor)
          const member = this.accounts.get(target.username), actual = this.runtime.status(target.username)
          if (!member || member.disabled || member.spaceId !== target.spaceId || actual.state !== 'ready' || actual.instance !== applied.instance) {
            results.push({ username: target.username, status: 'changed' }); continue
          }
          if (!applied.instance.resourceLimits || !instanceResourcesApplied(applied.instance.resourceLimits, limits)) throw new Error('Resource application could not be confirmed')
          results.push({ username: target.username, status: 'applied', method: applied.method })
        } catch {
          this.assertAdmin(actor)
          results.push({ username: target.username, status: 'failed', code: 'instance-resource-apply-failed' })
        }
      }
      return { results }
    })
  }
  /** Non-sensitive account-list summary; the authenticated admin route owns its enclosing view. */
  pendingFor(account: CommunityAccountRecord): boolean { return this.view(account, this.store.read()).pending }
  reconcileMembers(): Promise<void> {
    return this.serial(() => {
      const state = this.store.read(), spaces = new Set(this.accounts.list().map(account => account.spaceId))
      const residents = Object.fromEntries(Object.entries(state.residents).filter(([space]) => spaces.has(space)))
      if (Object.keys(residents).length !== Object.keys(state.residents).length) this.store.save({ ...state, revision: state.revision + 1, residents })
      this.residents?.settingsChanged()
    })
  }
  async stop(): Promise<void> { this.stopping = true; await this.pending }
  private view(account: CommunityAccountRecord, state: InstanceResourceState): CommunityInstanceResourceMember {
    const override = state.overrides[account.spaceId], target = effectiveInstanceResources(state.defaults, override), status = this.runtime.status(account.username)
    const instance = status.state === 'ready' || status.state === 'draining' ? status.instance : undefined
    const current = this.isolated ? instance?.resourceLimits : undefined
    const startup = this.residents?.failure(account.spaceId)
    return { resident: state.residents[account.spaceId] === true, automaticStartFailure: startup, isolated: this.isolated, defaults: state.defaults, username: account.username, spaceId: account.spaceId, revision: state.revision, source: override ? 'custom' : 'default', override: override ?? null,
      target, current: current?.limits ?? null, instanceKey: instance?.resourceKey ?? null,
      pending: this.isolated && !!instance && (!current || !instanceResourcesApplied(current, target)) }
  }
  private fresh(revision: unknown): InstanceResourceState {
    if (!Number.isSafeInteger(revision)) throw invalid()
    const state = this.store.read()
    if (revision !== state.revision) throw stale()
    return state
  }
  private account(username: string): CommunityAccountRecord {
    const account = this.accounts.get(username)
    if (!account) throw new BusinessRuleError('missing', 'Account not found.', 'account-not-found')
    return account
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
  private serial<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new BusinessRuleError('conflict', 'Resource application is stopping.', 'instance-resource-apply-failed'))
    const task = this.pending.then(operation)
    this.pending = task.then(() => {}, () => {})
    return task
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function invalid() { return new BusinessRuleError('invalid', 'Review the instance resource settings.', 'instance-resource-invalid') }
function stale() { return new BusinessRuleError('conflict', 'Instance resource settings changed. Reload before saving or applying.', 'instance-resource-revision-conflict') }
