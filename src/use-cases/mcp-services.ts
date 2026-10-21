import { combineAcquisitionSources } from '../domain/acquisition-sources.js'
import { assertCatalogConfiguration, catalogInput, mcpPresets, type McpPreset } from '../domain/mcp-catalog.js'
import type { CommunityMcpCatalogInput, CommunityMarketMcp, CommunityMcpTool, CommunityMcpInput, CommunityMcpSettings, CommunityMcpGroup } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { assertOrdinaryGroup, requiredCommunityGroup } from '../domain/community-group.js'
import { validateMcpSettings, mcpSettings, type McpService } from '../domain/mcp-service.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { McpStorePort, McpProjectionPort, MemberMcpPort, McpRuntimePort } from '../ports/mcp-services.js'
import type { ExpertMcpPort } from '../ports/experts.js'

/** Owns MCP desired state and the single effective-service policy used by projections and the gateway. */
export class McpServices implements MemberMcpPort {
  private readonly observers = new Set<() => void>()
  private preparedSnapshot: string | undefined
  private stopping = false
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly store: McpStorePort, private readonly projection: McpProjectionPort, private readonly runtime?: McpRuntimePort, private readonly presets: readonly McpPreset[] = mcpPresets, private readonly afterProjection: () => Promise<void> = async () => {}, private readonly experts?: ExpertMcpPort) {}
  /** Every authorization source contributes a commit version; substitutes without one recheck. */
  version(): string | undefined {
    const store = this.store.version?.(), experts = this.experts ? this.experts.version?.() : 0, runtime = this.runtime ? this.runtime.version?.() : 0
    return store === undefined || experts === undefined || runtime === undefined ? undefined : `${store}:${experts}:${runtime}`
  }
  list(actor: CommunityAccountActor): readonly CommunityMcpSettings[] { this.assertAdmin(actor); return this.store.read().services.map(service => this.settings(service)) }
  catalog(actor: CommunityAccountActor) {
    this.assertAdmin(actor)
    const services = this.store.read().services
    return this.presets.map(({ entry }) => ({ ...entry, imported: services.filter(service => service.catalog?.id === entry.id).length }))
  }
  catalogUpdatePreview(actor: CommunityAccountActor, name: string): import('../domain/admin-contract.js').CommunityMcpCatalogUpdatePreview {
    this.assertAdmin(actor)
    const service = this.store.read().services.find(row => row.name === name)
    const preset = this.presets.find(row => row.entry.id === service?.catalog?.id)
    if (!service?.catalog || !preset) throw new BusinessRuleError('missing', 'MCP catalog service was not found.', 'not-found')
    const fields = ['description', 'url', 'run', 'headers', 'query'] as const
    return { currentVersion: service.catalog.version, version: preset.entry.version, credentialRequired: Boolean(preset.entry.credentialLabel && !service.credential),
      changes: fields.flatMap(field => { const before = JSON.stringify(service[field] ?? null), after = JSON.stringify(preset.configuration[field] ?? null); return before === after ? [] : [{ field, before, after }] }) }
  }
  async beginCatalogUpdate(actor: CommunityAccountActor, input: import('../domain/admin-contract.js').CommunityMcpCatalogUpdateInput): Promise<{ name: string, pending: boolean }> {
    let operation: { name: string, pending: boolean } | undefined
    try {
      await this.mutate(actor, () => {
        if (!input || Object.keys(input).some(key => !['name', 'version', 'requestId', 'credential'].includes(key)) || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(input.requestId)) throw new BusinessRuleError('invalid', 'Invalid MCP catalog input.', 'mcp-service-invalid')
        const state = this.store.read(), previous = state.services.find(row => row.name === input.name)
        if (!previous?.catalog) throw new BusinessRuleError('missing', 'MCP catalog service was not found.', 'not-found')
        if (state.catalogRequests?.includes(input.requestId)) {
          if (previous.catalogUpdate?.requestId !== input.requestId) throw new BusinessRuleError('conflict', 'This import was removed. Start a new import.', 'mcp-import-retired')
          operation = { name: previous.catalogUpdate.name, pending: Boolean(previous.catalogUpdate.candidate) }; return
        }
        const preset = this.presets.find(row => row.entry.id === previous.catalog!.id)
        if (!preset || input.version !== preset.entry.version || previous.catalog.version === input.version || previous.catalog.status !== 'ready' || previous.catalogUpdate?.candidate) throw new BusinessRuleError('conflict', 'MCP settings changed during the test.', 'mcp-test-stale')
        const generation = Math.max(state.revision ?? 0, ...state.services.map(row => row.generation)) + 1, name = `p-update-${generation}`
        if (state.services.some(row => row.name === name)) throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
        const settings = catalogInput({ presetId: previous.catalog.id, name, credential: input.credential ?? previous.credential ?? '', requestId: input.requestId }, this.presets)
        validateMcpSettings(settings)
        const status = settings.run ? 'preparing' as const : 'testing' as const
        const candidate: McpService = { ...settings, ...(previous.dependencyName ? { dependencyTarget: previous.dependencyName } : {}), preparationName: `catalog-update:${generation}`, generation, catalog: { id: previous.catalog.id, version: input.version, status }, testStatus: 'untested' }
        const catalogUpdate = { name, requestId: input.requestId, version: input.version, baseGeneration: previous.generation, actor, status, candidate }
        this.store.write({ ...state, revision: generation, catalogRequests: [...state.catalogRequests ?? [], input.requestId], services: state.services.map(row => row === previous ? { ...row, catalogUpdate } : row) })
        operation = { name, pending: true }
      })
    } catch (error) { if (operation?.pending) await this.failCatalogUpdate(operation.name).catch(() => {}); throw error }
    return operation!
  }
  private currentCatalogUpdate(actor: CommunityAccountActor, name: string) {
    this.assertAdmin(actor)
    const state = this.store.read(), service = state.services.find(row => row.catalogUpdate?.name === name), update = service?.catalogUpdate
    if (!service || !update?.candidate || service.generation !== update.baseGeneration || update.actor.username !== actor.username || update.actor.spaceId !== actor.spaceId || update.actor.sessionEpoch !== actor.sessionEpoch) throw new BusinessRuleError('conflict', 'MCP settings changed during the test.', 'mcp-test-stale')
    return { state, service, update, candidate: update.candidate }
  }
  private preparationIdentity(service: McpService): string {
    const prepared = this.runtime?.ready(service)
    return JSON.stringify([prepared?.directory, prepared?.dependencies?.map(row => row.id)])
  }
  catalogUpdatePreparation(actor: CommunityAccountActor, name: string): 'ready' | 'waiting' {
    const { candidate } = this.currentCatalogUpdate(actor, name)
    if (!candidate.run || this.runtime?.ready(candidate)) return 'ready'
    if (this.runtime?.view(candidate)?.stage === 'failed') throw new BusinessRuleError('conflict', 'MCP preparation failed.', 'mcp-runtime-not-ready')
    return 'waiting'
  }
  testCatalogUpdate(actor: CommunityAccountActor, name: string): Promise<void> {
    return this.mutate(actor, () => {
      const { state, service, update } = this.currentCatalogUpdate(actor, name)
      if (this.catalogUpdatePreparation(actor, name) !== 'ready') throw new BusinessRuleError('conflict', 'MCP preparation failed.', 'mcp-runtime-not-ready')
      this.store.write({ ...state, services: state.services.map(row => row === service ? { ...row, catalogUpdate: { ...update, testedPreparation: this.preparationIdentity(update.candidate!), status: 'testing' } } : row) })
    })
  }
  finishCatalogUpdate(actor: CommunityAccountActor, name: string, tools: readonly CommunityMcpTool[] | undefined): Promise<void> {
    return this.mutate(actor, () => {
      const { state, service, update, candidate } = this.currentCatalogUpdate(actor, name)
      if (!tools) { this.store.write({ ...state, services: state.services.map(row => row === service ? { ...row, catalogUpdate: { ...update, candidate: undefined, status: 'failed' } } : row) }); return }
      if (update.testedPreparation !== this.preparationIdentity(candidate)) throw new BusinessRuleError('conflict', 'MCP dependencies changed during the test.', 'mcp-test-stale')
      const selected = this.runtime?.promote?.(candidate, service) ?? candidate
      const next: McpService = { ...service, ...selected, name: service.name, published: service.published ?? false, required: service.required ?? false, disabledTools: service.disabledTools ?? [],
        ...(service.catalogRequestId ? { catalogRequestId: service.catalogRequestId } : {}), catalog: { ...candidate.catalog!, status: 'ready' }, testStatus: 'passed', tools,
        catalogUpdate: { ...update, candidate: undefined, status: 'applied' } }
      this.store.write({ ...state, services: state.services.map(row => row === service ? next : row) })
    })
  }
  failCatalogUpdate(name: string): Promise<void> {
    return this.enqueue(async () => {
      const state = this.store.read()
      this.store.write({ ...state, services: state.services.map(row => row.catalogUpdate?.name === name && row.catalogUpdate.candidate ? { ...row, catalogUpdate: { ...row.catalogUpdate, candidate: undefined, status: 'failed' } } : row) })
      await this.synchronize()
    })
  }
  importCatalog(actor: CommunityAccountActor, input: CommunityMcpCatalogInput) {
    return this.catalogMutation(actor, () => {
      const settings = catalogInput(input, this.presets)
      validateMcpSettings(settings)
      const state = this.store.read()
      if (state.catalogRequests?.includes(input.requestId)) {
        const existing = state.services.find(row => row.catalogRequestId === input.requestId)
        if (!existing) throw new BusinessRuleError('conflict', 'This import was removed. Start a new import.', 'mcp-import-retired')
        return existing
      }
      if (state.services.some(row => row.name === input.name || row.catalogUpdate?.candidate?.name === input.name)) throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
      const generation = Math.max(state.revision ?? 0, ...state.services.map(row => row.generation)) + 1
      const service: McpService = { ...settings, generation, published: false, required: false, testStatus: 'untested', catalogRequestId: input.requestId, catalog: { id: input.presetId, version: this.presets.find(row => row.entry.id === input.presetId)!.entry.version, status: settings.run ? 'preparing' : 'testing' } }
      this.store.write({ ...state, revision: generation, catalogRequests: [...state.catalogRequests ?? [], input.requestId], services: [...state.services, service] })
      return service
    })
  }
  async beginCatalogTest(actor: CommunityAccountActor, name: string, expectedGeneration?: number): Promise<number> {
    const operation = await this.catalogMutation(actor, () => {
      const state = this.store.read(), service = state.services.find(row => row.name === name)
      if (!service?.catalog) throw new BusinessRuleError('missing', 'MCP catalog service was not found.', 'not-found')
      if (expectedGeneration !== undefined && service.generation !== expectedGeneration) throw new BusinessRuleError('conflict', 'MCP settings changed during preparation.', 'mcp-test-stale')
      if (service.run && this.runtime?.view(service)?.stage === 'failed') this.runtime.restart(name)
      const next: McpService = { ...service, catalog: { ...service.catalog, status: service.run && !this.runtime?.ready(service) ? 'preparing' : 'testing' } }
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
    return { name: service!.name, generation: service!.generation, testing: service!.catalog?.status === 'testing' || service!.catalog?.status === 'preparing' }
  }
  failCatalogTest(name: string, generation: number): Promise<void> {
    return this.enqueue(async () => {
      const state = this.store.read()
      this.store.write({ ...state, services: state.services.map(row => row.name === name && row.generation === generation && (row.catalog?.status === 'testing' || row.catalog?.status === 'preparing')
        ? { ...row, testStatus: 'failed', catalog: { ...row.catalog, status: 'failed' } } : row) })
      await this.synchronize()
    })
  }
  interruptCatalogTests(): Promise<void> {
    return this.enqueue(async () => {
      const state = this.store.read()
      this.store.write({ ...state, services: state.services.map(row => ({ ...row, ...(row.catalogUpdate?.candidate ? { catalogUpdate: { ...row.catalogUpdate, candidate: undefined, status: 'failed' as const } } : {}), ...((row.catalog?.status === 'testing' || row.catalog?.status === 'preparing') ? { testStatus: 'failed' as const, catalog: { ...row.catalog, status: 'failed' as const } } : {}) })) })
      await this.synchronize()
    })
  }
  observe(listener: () => void): () => void { this.observers.add(listener); return () => { this.observers.delete(listener) } }
  catalogPreparation(actor: CommunityAccountActor, name: string, generation: number): 'ready' | 'waiting' {
    this.assertAdmin(actor)
    const service = this.store.read().services.find(row => row.name === name)
    if (!service || service.generation !== generation) throw new BusinessRuleError('conflict', 'MCP settings changed during preparation.', 'mcp-test-stale')
    if (!service.run || this.runtime?.ready(service)) return 'ready'
    if (this.runtime?.view(service)?.stage === 'failed') throw new BusinessRuleError('conflict', 'MCP preparation failed.', 'mcp-runtime-not-ready')
    return 'waiting'
  }
  effective(username: string): readonly McpService[] {
    return this.prepared(this.available(username).filter(row => row.enabled).map(row => row.service))
  }
  accessible(username: string): readonly McpService[] {
    const acquired = combineAcquisitionSources([
      { source: 'managed', names: this.effective(username).map(row => row.name) },
      { source: 'managed', names: this.expertNames(username) },
    ])
    return this.prepared(this.store.read().services.filter(service => acquired.has(service.name)))
  }
  expertProjection(username: string) { return { services: this.accessible(username), global: this.effective(username).map(row => row.name) } }
  private expertNames(username: string): readonly string[] {
    const account = this.accounts.get(username)
    return account && !account.disabled && this.accounts.listGroups().some(group => group.id === account.groupId) ? this.experts?.mcp(username) ?? [] : []
  }
  private prepared(services: readonly McpService[]): readonly McpService[] {
    return services.flatMap(service => {
      if (service.catalog && service.catalog.status !== 'ready') return []
      const prepared = this.runtime?.ready(service)
      return !service.run ? [service] : prepared ? [{ ...service, prepared }] : []
    })
  }
  memberDependencies(username: string) {
    const names = new Set([...this.available(username).filter(row => row.granted || row.enabled).map(row => row.service.name), ...this.expertNames(username)])
    return [...new Map(this.store.read().services.flatMap(service => names.has(service.name) && service.run?.location === 'member' && (!service.catalog || service.catalog.status === 'ready') ? this.runtime?.ready(service)?.dependencies ?? [] : []).map(row => [row.id, row])).values()]
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
    const acquired = combineAcquisitionSources([
      { source: 'managed', names: state.services.filter(row => group.kind === 'admin' || names.has(row.name)).map(row => row.name) },
      { source: 'selected', names: state.services.filter(row => row.published && state.selections?.[account.spaceId]?.includes(row.name)).map(row => row.name) },
    ])
    return state.services.filter(row => row.published || acquired.has(row.name)).sort((a, b) => a.name.localeCompare(b.name)).map(service => {
      const source = acquired.get(service.name)
      const granted = source === 'managed', required = granted && Boolean(service.required)
      const enabled = required || (granted ? state.preferences?.[account.spaceId]?.[service.name] ?? group.kind !== 'admin' : acquired.has(service.name))
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
      if (state.services.some(row => row.catalogUpdate?.candidate?.name === input.name)) throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
      const previous = state.services.find(item => item.name === (originalName ?? input.name))
      if (originalName !== undefined && (!previous || create)) throw new BusinessRuleError('missing', 'MCP service was not found.', 'not-found')
      if (originalName !== undefined && originalName !== input.name && state.services.some(row => row.name === input.name)) throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
      if (previous) assertCatalogConfiguration(previous, input)
      const credentials = { ...previous?.credentials, ...input.credentials }
      const merged = { ...input, run: input.run === undefined ? previous?.run ?? null : input.run, credential: input.credential ?? previous?.credential ?? '', credentials }
      validateMcpSettings(merged)
      this.runtime?.validateReferences?.(merged.run, previous?.run)
      const connectionChanged = !previous || JSON.stringify(merged.run) !== JSON.stringify(previous.run ?? null) || JSON.stringify(credentials) !== JSON.stringify(previous.credentials ?? {}) || previous.url !== input.url || (input.credential !== undefined && input.credential !== previous.credential) || (input.headers !== undefined && JSON.stringify(input.headers) !== JSON.stringify(previous.headers ?? [])) || (input.query !== undefined && JSON.stringify(input.query) !== JSON.stringify(previous.query ?? []))
      const row: McpService = { ...previous, ...(previous?.catalogUpdate?.candidate ? { catalogUpdate: { ...previous.catalogUpdate, candidate: undefined, status: 'failed' as const } } : {}), run: merged.run, credentials, required: input.required ?? previous?.required ?? false, published: previous?.published ?? false, name: input.name, description: input.description, url: input.url, generation: (state.revision ?? Math.max(0, ...state.services.map(service => service.generation))) + 1, credential: input.credential ?? previous?.credential ?? '', headers: input.headers ?? previous?.headers ?? [], query: input.query ?? previous?.query ?? [], disabledTools: input.disabledTools ?? previous?.disabledTools ?? [], testStatus: connectionChanged ? 'untested' : previous?.testStatus ?? 'untested' }
      if (previous?.catalog && (connectionChanged || ['testing', 'preparing'].includes(previous.catalog.status))) {
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
    return diagnostic ? this.diagnostic(username, name) : this.accessible(username).find(row => row.name === name)
  }
  diagnostic(username: string, name: string): McpService {
    const account = this.accounts.get(username)
    if (!account || account.disabled || !account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
    const rows = this.store.read().services
    const service = rows.find(row => row.name === name) ?? rows.find(row => row.catalogUpdate?.candidate?.name === name)?.catalogUpdate?.candidate
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
    const available = this.presets.find(row => row.entry.id === service.catalog?.id)?.entry.version
    return { ...mcpSettings(service), ...(available && available !== service.catalog?.version ? { availableCatalogVersion: available } : {}), ...(preparation ? { preparation } : {}) }
  }
  prepare(): Promise<void> {
    return this.enqueue(async () => {
      const snapshot = this.preparationSnapshot()
      if (snapshot !== undefined && snapshot === this.preparedSnapshot) return
      await this.synchronize()
    })
  }
  private preparationSnapshot(): string | undefined {
    const runtime = this.runtime ? (this.runtime.preparationSnapshot ? this.runtime.preparationSnapshot() : this.runtime.version?.()) : 0, experts = this.experts ? this.experts.version?.() : 0
    if (runtime === undefined || experts === undefined) return undefined
    return JSON.stringify([this.store.read(), runtime, experts, this.accounts.list().map(row => [row.username, row.spaceId, row.groupId, row.disabled]).sort(), this.accounts.listGroups()])
  }
  recover(): Promise<void> { return this.enqueue(() => this.synchronize()) }
  async stop(): Promise<void> { this.stopping = true; await this.pending }
  private mutate(actor: CommunityAccountActor, update: () => void): Promise<void> {
    return this.enqueue(async () => { this.assertAdmin(actor); update(); await this.synchronize() })
  }
  private async synchronize(): Promise<void> {
    const snapshot = this.preparationSnapshot()
    this.preparedSnapshot = undefined
    try {
      if (this.runtime?.configure) {
        const state = this.store.read(), services = state.services.map(service => {
          const current = this.runtime!.configure!(service)
          return current.catalogUpdate?.candidate ? { ...current, catalogUpdate: { ...current.catalogUpdate, candidate: this.runtime!.configure!(current.catalogUpdate.candidate) } } : current
        })
        if (JSON.stringify(services) !== JSON.stringify(state.services)) this.store.write({ ...state, services })
      }
      await this.runtime?.changed()
      await this.projection.synchronize(this.accounts.list().map(account => ({ username: account.username, spaceId: account.spaceId, services: this.effective(account.username) })))
      await this.afterProjection()
      if (snapshot === this.preparationSnapshot()) this.preparedSnapshot = snapshot
    } finally { for (const observer of this.observers) observer() }
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
