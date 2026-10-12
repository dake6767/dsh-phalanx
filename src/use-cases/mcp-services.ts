import type { CommunityMcpTool, CommunityMcpInput, CommunityMcpSettings, CommunityMcpGroup } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { assertOrdinaryGroup, requiredCommunityGroup } from '../domain/community-group.js'
import { validateMcpSettings, mcpSettings, type McpService } from '../domain/mcp-service.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { McpStorePort, McpProjectionPort, MemberMcpPort } from '../ports/mcp-services.js'

/** Owns MCP desired state and the single effective-service policy used by projections and the gateway. */
export class McpServices implements MemberMcpPort {
  private stopping = false
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly store: McpStorePort, private readonly projection: McpProjectionPort) {}
  list(actor: CommunityAccountActor): readonly CommunityMcpSettings[] { this.assertAdmin(actor); return this.store.read().services.map(mcpSettings) }
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
    return { groupId: id, implicit: group.kind === 'admin', services: state.services.map(row => ({ ...mcpSettings(row), granted: group.kind === 'admin' || granted.has(row.name) })) }
  }
  save(actor: CommunityAccountActor, input: CommunityMcpInput, create = false): Promise<void> {
    return this.mutate(actor, () => {
      validateMcpSettings(input)
      const state = this.store.read()
      if (create && state.services.some(row => row.name === input.name)) throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-service-invalid')
      const previous = state.services.find(item => item.name === input.name)
      const connectionChanged = !previous || previous.url !== input.url || (input.credential !== undefined && input.credential !== previous.credential) || (input.headers !== undefined && JSON.stringify(input.headers) !== JSON.stringify(previous.headers ?? [])) || (input.query !== undefined && JSON.stringify(input.query) !== JSON.stringify(previous.query ?? []))
      const row: McpService = { ...previous, name: input.name, description: input.description, url: input.url, generation: (state.revision ?? Math.max(0, ...state.services.map(service => service.generation))) + 1, credential: input.credential ?? previous?.credential ?? '', headers: input.headers ?? previous?.headers ?? [], query: input.query ?? previous?.query ?? [], disabledTools: input.disabledTools ?? previous?.disabledTools ?? [], testStatus: connectionChanged ? 'untested' : previous?.testStatus ?? 'untested' }
      this.store.write({ ...state, revision: row.generation, services: [...state.services.filter(item => item.name !== row.name), row].sort((a, b) => a.name.localeCompare(b.name)) })
    })
  }
  remove(actor: CommunityAccountActor, name: string): Promise<void> {
    return this.mutate(actor, () => {
      const state = this.store.read()
      this.store.write({ ...state, revision: Math.max(state.revision ?? 0, ...state.services.map(row => row.generation)), services: state.services.filter(row => row.name !== name), grants: Object.fromEntries(Object.entries(state.grants).map(([id, names]) => [id, names.filter(value => value !== name)])) })
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
  diagnostic(username: string, name: string): McpService {
    const account = this.accounts.get(username)
    if (!account || account.disabled || !account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
    const service = this.store.read().services.find(row => row.name === name)
    if (!service) throw new BusinessRuleError('missing', 'MCP service was not found', 'not-found')
    return service
  }
  recordTest(actor: CommunityAccountActor, name: string, generation: number, tools: readonly CommunityMcpTool[] | undefined): Promise<void> {
    return this.mutate(actor, () => {
      const state = this.store.read(), previous = state.services.find(row => row.name === name)
      if (!previous || previous.generation !== generation) throw new BusinessRuleError('conflict', 'MCP settings changed during the test. Test the saved settings again.', 'mcp-test-stale')
      const known = new Set(previous.tools?.map(row => row.name) ?? [])
      const next = { ...previous, testStatus: tools ? 'passed' as const : 'failed' as const,
        tools: tools?.map(row => ({ ...row, isNew: !known.has(row.name) })) ?? previous.tools ?? [] }
      this.store.write({ ...state, services: state.services.map(row => row.name === name ? next : row) })
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
