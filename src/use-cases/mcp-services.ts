import { assertCatalogConfiguration, catalogInput, mcpCatalog } from '../domain/mcp-catalog.js'
import type { CommunityMcpCatalogInput, CommunityMarketMcp, CommunityMcpTool, CommunityMcpInput, CommunityMcpSettings, CommunityMcpGroup } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { assertOrdinaryGroup, requiredCommunityGroup } from '../domain/community-group.js'
import { validateMcpSettings, mcpSettings, type McpService } from '../domain/mcp-service.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { McpStorePort, McpProjectionPort, MemberMcpPort, McpRuntimePort } from '../ports/mcp-services.js'

/** Owns MCP desired state and the single effective-service policy used by projections and the gateway. */
export class McpServices implements MemberMcpPort {
  private stopping = false
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly store: McpStorePort, private readonly projection: McpProjectionPort, private readonly runtime?: McpRuntimePort) {}
  list(actor: CommunityAccountActor): readonly CommunityMcpSettings[] { this.assertAdmin(actor); return this.store.read().services.map(service => this.settings(service)) }
  catalog(actor: CommunityAccountActor) {
    this.assertAdmin(actor)
    const services = this.store.read().services
    return mcpCatalog.map(row => ({ ...row, imported: services.filter(service => service.catalog?.id === row.id).length }))
  }
  importCatalog(actor: CommunityAccountActor, input: CommunityMcpCatalogInput) {
    return this.catalogMutation(actor, () => {
      const settings = catalogInput(input)
      validateMcpSettings(settings)
      const state = this.store.read()
      if (state.catalogRequests?.includes(input.requestId)) {
        const existing = state.services.find(row => row.catalogRequestId === input.requestId)
        if (!existing) throw new BusinessRuleError('conflict', 'This import was removed. Start a new import.', 'mcp-import-retired')
        return existing
      }
      if (state.services.some(row => row.name === input.name)) throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
      const generation = Math.max(state.revision ?? 0, ...state.services.map(row => row.generation)) + 1
      const service: McpService = { ...settings, generation, published: false, required: false, testStatus: 'untested', catalogRequestId: input.requestId, catalog: { id: input.presetId, version: '1', status: 'testing' } }
      this.store.write({ ...state, revision: generation, catalogRequests: [...state.catalogRequests ?? [], input.requestId], services: [...state.services, service] })
      return service
    })
  }
  async beginCatalogTest(actor: CommunityAccountActor, name: string): Promise<number> {
    const operation = await this.catalogMutation(actor, () => {
      const state = this.store.read(), service = state.services.find(row => row.name === name)
      if (!service?.catalog) throw new BusinessRuleError('missing', 'MCP market service was not found.', 'not-found')
      const next = { ...service, catalog: { ...service.catalog, status: 'testing' as const } }
      this.store.write({ ...state, services: state.services.map(row => row === service ? next : row) })
      return next
    })
    return operation.generation
  }
  private async catalogMutation(actor: CommunityAccountActor, change: () => McpService) {
    let service: McpService | undefined
    try { await this.mutate(actor, () => { service = change() }) }
    catch (error) {
      // Persistence precedes projection: even a failed handoff must leave a retryable row.
      if (service) await this.failCatalogTest(service.name, service.generation).catch(() => undefined)
      throw error
    }
    return { name: service!.name, generation: service!.generation, testing: service!.catalog?.status === 'testing' }
  }
  failCatalogTest(name: string, generation: number): Promise<void> {
    return this.enqueue(async () => {
      const state = this.store.read()
      this.store.write({ ...state, services: state.services.map(row => row.name === name && row.generation === generation && row.catalog?.status === 'testing'
        ? { ...row, testStatus: 'failed', catalog: { ...row.catalog, status: 'failed' } } : row) })
      await this.synchronize()
    })
  }
  interruptCatalogTests(): Promise<void> {
    return this.enqueue(async () => {
      const state = this.store.read()
      this.store.write({ ...state, services: state.services.map(row => row.catalog?.status === 'testing' ? { ...row, testStatus: 'failed', catalog: { ...row.catalog, status: 'failed' } } : row) })
      await this.synchronize()
    })
  }
  effective(username: string): readonly McpService[] {
    return this.available(username).flatMap(({ service, enabled }) => {
      if (!enabled || (service.catalog && service.catalog.status !== 'ready')) return []
      const prepared = this.runtime?.ready(service)
      return !service.run ? [service] : prepared ? [{ ...service, prepared }] : []
    })
  }
  market(actor: CommunityAccountActor): readonly CommunityMarketMcp[] {
    this.assertMember(actor)
    return this.available(actor.username).map(({ service, granted, enabled, required }) => ({ name: service.name, description: service.description, granted, enabled, required,
      tools: (service.tools ?? []).filter(tool => !service.disabledTools?.includes(tool.name)).map(tool => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }) })) }))
  }
  toggle(actor: CommunityAccountActor, name: string, enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.assertMember(actor)
      const row = this.available(actor.username).find(row => row.service.name === name)
      if (!row) throw new BusinessRuleError('forbidden', 'MCP service is unavailable.', 'mcp-grant-invalid')
      if (row.required && !enabled) throw new BusinessRuleError('forbidden', 'This MCP service is required by your administrator.', 'mcp-required')
      const state = this.store.read(), previous = state.selections?.[actor.spaceId] ?? []
      const selections = { ...state.selections, [actor.spaceId]: !row.granted && enabled ? [...new Set([...previous, name])] : enabled ? previous : previous.filter(value => value !== name) }
      const preferences = row.granted ? { ...state.preferences, [actor.spaceId]: { ...state.preferences?.[actor.spaceId], [name]: enabled } } : state.preferences
      this.store.write({ ...state, selections, ...(preferences ? { preferences } : {}) }); await this.synchronize()
    })
  }
  publish(actor: CommunityAccountActor, name: string, published: boolean): Promise<void> {
    return this.mutate(actor, () => {
      const state = this.store.read(), service = state.services.find(row => row.name === name)
      if (!service) throw new BusinessRuleError('missing', 'MCP service was not found.', 'not-found')
      if (published && (service.testStatus !== 'passed' || (service.catalog && service.catalog.status !== 'ready'))) throw new BusinessRuleError('conflict', 'Test this MCP service successfully before publishing.', 'mcp-test-required')
      this.store.write({ ...(published ? state : this.withoutSelections(state, name)), services: state.services.map(row => row.name === name ? { ...row, published } : row) })
    })
  }
  private available(username: string) {
    const account = this.accounts.get(username)
    if (!account || account.disabled) return []
    const group = this.accounts.listGroups().find(row => row.id === account.groupId)
    if (!group) return []
    const state = this.store.read(), names = new Set(Object.hasOwn(state.grants, group.id) ? state.grants[group.id] : [])
    return state.services.filter(row => row.published || group.kind === 'admin' || names.has(row.name)).sort((a, b) => a.name.localeCompare(b.name)).map(service => {
      const granted = group.kind === 'admin' || names.has(service.name), required = granted && Boolean(service.required)
      const enabled = required || (granted ? state.preferences?.[account.spaceId]?.[service.name] ?? group.kind !== 'admin' : Boolean(service.published && state.selections?.[account.spaceId]?.includes(service.name)))
      return { service, granted, required, enabled }
    })
  }
  private withoutSelections(state: import('../domain/mcp-service.js').McpState, name: string) {
    return { ...state, selections: Object.fromEntries(Object.entries(state.selections ?? {}).map(([id, names]) => [id, names.filter(value => value !== name)])) }
  }
  group(actor: CommunityAccountActor, id: string): CommunityMcpGroup {
    this.assertAdmin(actor)
    const group = requiredCommunityGroup(this.accounts.listGroups(), id), state = this.store.read()
    const granted = new Set(Object.hasOwn(state.grants, id) ? state.grants[id] : [])
    return { groupId: id, implicit: group.kind === 'admin', services: state.services.map(row => ({ ...mcpSettings(row), granted: group.kind === 'admin' || granted.has(row.name) })) }
  }
  save(actor: CommunityAccountActor, input: CommunityMcpInput, create = false, originalName?: string): Promise<void> {
    return this.mutate(actor, () => {
      validateMcpSettings(input)
      const state = this.store.read()
      if (create && state.services.some(row => row.name === input.name)) throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
      const previous = state.services.find(item => item.name === (originalName ?? input.name))
      if (originalName !== undefined && (!previous || create)) throw new BusinessRuleError('missing', 'MCP service was not found.', 'not-found')
      if (originalName !== undefined && originalName !== input.name && state.services.some(row => row.name === input.name)) throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
      if (previous) assertCatalogConfiguration(previous, input)
      const credentials = { ...previous?.credentials, ...input.credentials }
      const merged = { ...input, run: input.run === undefined ? previous?.run ?? null : input.run, credential: input.credential ?? previous?.credential ?? '', credentials }
      validateMcpSettings(merged)
      const connectionChanged = !previous || JSON.stringify(merged.run) !== JSON.stringify(previous.run ?? null) || JSON.stringify(credentials) !== JSON.stringify(previous.credentials ?? {}) || previous.url !== input.url || (input.credential !== undefined && input.credential !== previous.credential) || (input.headers !== undefined && JSON.stringify(input.headers) !== JSON.stringify(previous.headers ?? [])) || (input.query !== undefined && JSON.stringify(input.query) !== JSON.stringify(previous.query ?? []))
      const row: McpService = { ...previous, run: merged.run, credentials, required: input.required ?? previous?.required ?? false, published: previous?.published ?? false, name: input.name, description: input.description, url: input.url, generation: (state.revision ?? Math.max(0, ...state.services.map(service => service.generation))) + 1, credential: input.credential ?? previous?.credential ?? '', headers: input.headers ?? previous?.headers ?? [], query: input.query ?? previous?.query ?? [], disabledTools: input.disabledTools ?? previous?.disabledTools ?? [], testStatus: connectionChanged ? 'untested' : previous?.testStatus ?? 'untested' }
      if (previous?.catalog && (connectionChanged || previous.catalog.status === 'testing')) {
        Object.assign(row, { catalog: { ...previous.catalog, status: 'failed' } })
      }
      const rename = (name: string) => name === previous?.name ? row.name : name
      const renamed = previous && previous.name !== row.name ? {
        grants: Object.fromEntries(Object.entries(state.grants).map(([id, names]) => [id, names.map(rename)])),
        selections: Object.fromEntries(Object.entries(state.selections ?? {}).map(([id, names]) => [id, names.map(rename)])),
        preferences: Object.fromEntries(Object.entries(state.preferences ?? {}).map(([id, values]) => [id, Object.fromEntries(Object.entries(values).map(([name, enabled]) => [rename(name), enabled]))])),
      } : {}
      this.store.write({ ...state, ...renamed, revision: row.generation, services: [...state.services.filter(item => item.name !== (previous?.name ?? row.name)), row].sort((a, b) => a.name.localeCompare(b.name)) })
    })
  }
  remove(actor: CommunityAccountActor, name: string): Promise<void> {
    return this.mutate(actor, () => {
      const state = this.store.read()
      this.store.write({ ...this.withoutSelections(state, name), preferences: Object.fromEntries(Object.entries(state.preferences ?? {}).map(([id, values]) => [id, Object.fromEntries(Object.entries(values).filter(([key]) => key !== name))])), revision: Math.max(state.revision ?? 0, ...state.services.map(row => row.generation)), services: state.services.filter(row => row.name !== name), grants: Object.fromEntries(Object.entries(state.grants).map(([id, names]) => [id, names.filter(value => value !== name)])) })
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
  runtimeService(username: string, name: string, diagnostic: boolean): McpService | undefined {
    return diagnostic ? this.diagnostic(username, name) : this.effective(username).find(row => row.name === name)
  }
  diagnostic(username: string, name: string): McpService {
    const account = this.accounts.get(username)
    if (!account || account.disabled || !account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
    const service = this.store.read().services.find(row => row.name === name)
    if (!service) throw new BusinessRuleError('missing', 'MCP service was not found', 'not-found')
    const prepared = this.runtime?.ready(service)
    if (service.run && !prepared) throw new BusinessRuleError('conflict', 'Prepare the MCP runtime before testing.', 'mcp-runtime-not-ready')
    return prepared ? { ...service, prepared } : service
  }
  recordTest(actor: CommunityAccountActor, name: string, generation: number, tools: readonly CommunityMcpTool[] | undefined): Promise<void> {
    return this.mutate(actor, () => {
      const state = this.store.read(), previous = state.services.find(row => row.name === name)
      if (!previous || previous.generation !== generation) throw new BusinessRuleError('conflict', 'MCP settings changed during the test. Test the saved settings again.', 'mcp-test-stale')
      const known = new Set(previous.tools?.map(row => row.name) ?? [])
      const next = { ...previous, ...(previous.catalog ? { catalog: { ...previous.catalog, status: tools ? 'ready' as const : 'failed' as const } } : {}), testStatus: tools ? 'passed' as const : 'failed' as const,
        tools: tools?.map(row => ({ ...row, isNew: !known.has(row.name) })) ?? previous.tools ?? [] }
      this.store.write({ ...state, services: state.services.map(row => row.name === name ? next : row) })
    })
  }
  reprepare(actor: CommunityAccountActor, name: string): void {
    this.assertAdmin(actor)
    const service = this.store.read().services.find(row => row.name === name)
    if (!service?.run || !this.runtime) throw new BusinessRuleError('conflict', 'Prepare the MCP runtime before testing.', 'mcp-runtime-not-ready')
    this.runtime.restart(name)
  }
  private settings(service: McpService): CommunityMcpSettings {
    const preparation = this.runtime?.view(service)
    return { ...mcpSettings(service), ...(preparation ? { preparation } : {}) }
  }
  async prepare(): Promise<void> { await this.recover() }
  recover(): Promise<void> { return this.enqueue(() => this.synchronize()) }
  async stop(): Promise<void> { this.stopping = true; await this.pending }
  private mutate(actor: CommunityAccountActor, update: () => void): Promise<void> {
    return this.enqueue(async () => { this.assertAdmin(actor); update(); await this.synchronize() })
  }
  private async synchronize(): Promise<void> {
    await this.runtime?.changed()
    return this.projection.synchronize(this.accounts.list().map(account => ({ username: account.username, spaceId: account.spaceId, services: this.effective(account.username) })))
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    if (this.stopping) return Promise.reject(new BusinessRuleError('conflict', 'MCP service management is stopping.', 'mcp-service-unavailable'))
    const next = this.pending.then(run); this.pending = next.catch(() => undefined); return next
  }
  private assertMember(actor: CommunityAccountActor) {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const account = this.assertMember(actor)
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
