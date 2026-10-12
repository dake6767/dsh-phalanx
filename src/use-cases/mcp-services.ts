import type { CommunityMcpService, CommunityMcpGroup } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { assertOrdinaryGroup, requiredCommunityGroup } from '../domain/community-group.js'
import { validateMcpService, type McpService } from '../domain/mcp-service.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { McpStorePort, McpProjectionPort, MemberMcpPort } from '../ports/mcp-services.js'

/** Owns MCP desired state and the single effective-service policy used by projections and the gateway. */
export class McpServices implements MemberMcpPort {
  private stopping = false
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly store: McpStorePort, private readonly projection: McpProjectionPort) {}
  list(actor: CommunityAccountActor): readonly CommunityMcpService[] { this.assertAdmin(actor); return this.store.read().services }
  effective(username: string): readonly McpService[] {
    const account = this.accounts.get(username)
    if (!account || account.disabled) return []
    const group = this.accounts.listGroups().find(row => row.id === account.groupId)
    if (!group || group.kind === 'admin') return []
    const state = this.store.read(), names = new Set(Object.hasOwn(state.grants, group.id) ? state.grants[group.id] : [])
    return state.services.filter(row => names.has(row.name)).sort((a, b) => a.name.localeCompare(b.name))
  }
  group(actor: CommunityAccountActor, id: string): CommunityMcpGroup {
    this.assertAdmin(actor)
    const group = requiredCommunityGroup(this.accounts.listGroups(), id), state = this.store.read()
    const granted = new Set(Object.hasOwn(state.grants, id) ? state.grants[id] : [])
    return { groupId: id, implicit: group.kind === 'admin', services: state.services.map(row => ({ ...row, granted: group.kind === 'admin' || granted.has(row.name) })) }
  }
  save(actor: CommunityAccountActor, input: CommunityMcpService, create = false): Promise<void> {
    return this.mutate(actor, () => {
      validateMcpService(input)
      const state = this.store.read()
      if (create && state.services.some(row => row.name === input.name)) throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-service-invalid')
      const row = { name: input.name, description: input.description, url: input.url, generation: (state.services.find(item => item.name === input.name)?.generation ?? 0) + 1 }
      this.store.write({ ...state, services: [...state.services.filter(item => item.name !== row.name), row].sort((a, b) => a.name.localeCompare(b.name)) })
    })
  }
  remove(actor: CommunityAccountActor, name: string): Promise<void> {
    return this.mutate(actor, () => {
      const state = this.store.read()
      this.store.write({ services: state.services.filter(row => row.name !== name), grants: Object.fromEntries(Object.entries(state.grants).map(([id, names]) => [id, names.filter(value => value !== name)])) })
    })
  }
  grant(actor: CommunityAccountActor, id: string, names: readonly string[]): Promise<void> {
    return this.mutate(actor, () => {
      assertOrdinaryGroup(requiredCommunityGroup(this.accounts.listGroups(), id))
      const state = this.store.read(), available = new Set(state.services.map(row => row.name))
      if (!Array.isArray(names) || names.some(name => !available.has(name))) throw new BusinessRuleError('invalid', 'Select MCP services from the library.', 'mcp-grant-invalid')
      this.store.write({ ...state, grants: { ...state.grants, [id]: [...new Set(names)].sort() } })
    })
  }
  async prepare(): Promise<void> { await this.recover() }
  recover(): Promise<void> { return this.enqueue(() => this.synchronize()) }
  async stop(): Promise<void> { this.stopping = true; await this.pending }
  private mutate(actor: CommunityAccountActor, update: () => void): Promise<void> {
    return this.enqueue(async () => { this.assertAdmin(actor); update(); await this.synchronize() })
  }
  private synchronize(): Promise<void> {
    return this.projection.synchronize(this.accounts.list().map(account => ({ username: account.username, spaceId: account.spaceId, services: this.effective(account.username) })))
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    if (this.stopping) return Promise.reject(new BusinessRuleError('conflict', 'MCP service management is stopping.', 'mcp-service-unavailable'))
    const next = this.pending.then(run); this.pending = next.catch(() => undefined); return next
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
