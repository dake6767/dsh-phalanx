import { McpCatalogOperations } from './mcp-catalog-operations.js'
import { setTimeout as delay } from 'node:timers/promises'
import { PlatformDatabaseError } from '../domain/platform-database.js'
import { mcpSecrets, redactMcpValue } from '../domain/mcp-protocol.js'
import { combineAcquisitionSources } from '../domain/acquisition-sources.js'
import { assertCatalogConfiguration, mcpPresets, type McpPreset } from '../domain/mcp-catalog.js'
import type { CommunityMarketMcp, CommunityMcpTool, CommunityMcpInput, CommunityMcpSettings, CommunityMcpGroup } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { requiredCommunityGroup } from '../domain/community-group.js'
import { mergeMcpInput, mcpSettings, type McpService } from '../domain/mcp-service.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { McpStatePort, McpProjectionPort, MemberMcpPort, McpRuntimePort } from '../ports/mcp-services.js'
import type { ExpertMcpPort } from '../ports/experts.js'
import { McpServiceRemoval } from './mcp-service-removal.js'
import type { McpRemovalImpact } from '../domain/mcp-removal.js'

/** Owns MCP desired state and the single effective-service policy used by projections and the gateway. */
export class McpServices implements MemberMcpPort {
  private readonly removal: McpServiceRemoval
  private readonly catalogOperations: McpCatalogOperations
  readonly catalog: McpCatalogOperations['catalog']
  readonly catalogUpdatePreview: McpCatalogOperations['catalogUpdatePreview']
  readonly beginCatalogUpdate: McpCatalogOperations['beginCatalogUpdate']
  readonly catalogUpdatePreparation: McpCatalogOperations['catalogUpdatePreparation']
  readonly testCatalogUpdate: McpCatalogOperations['testCatalogUpdate']
  readonly finishCatalogUpdate: McpCatalogOperations['finishCatalogUpdate']
  readonly failCatalogUpdate: McpCatalogOperations['failCatalogUpdate']
  readonly importCatalog: McpCatalogOperations['importCatalog']
  readonly beginCatalogTest: McpCatalogOperations['beginCatalogTest']
  readonly failCatalogTest: McpCatalogOperations['failCatalogTest']
  readonly interruptCatalogTests: McpCatalogOperations['interruptCatalogTests']
  readonly catalogPreparation: McpCatalogOperations['catalogPreparation']
  private readonly observers = new Set<() => void>()
  private preparedSnapshot: string | undefined
  private stopping = false
  private readonly shutdown = new AbortController()
  private pending: Promise<void> = Promise.resolve()
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly store: McpStatePort,
    private readonly projection: McpProjectionPort,
    private readonly runtime?: McpRuntimePort,
    private readonly presets: readonly McpPreset[] = mcpPresets,
    private readonly afterProjection: () => Promise<void> = async () => {},
    private readonly experts?: ExpertMcpPort,
  ) {
    this.removal = new McpServiceRemoval(store)
    this.catalogOperations = new McpCatalogOperations(
      store,
      presets,
      {
        assertAdmin: actor => this.assertAdmin(actor),
        mutate: (actor, update) => this.mutate(actor, update, false),
        enqueue: update => this.enqueue(update),
        synchronize: () => this.synchronize(),
      },
      runtime,
    )
    this.catalog = this.catalogOperations.catalog.bind(this.catalogOperations)
    this.catalogUpdatePreview = this.catalogOperations.catalogUpdatePreview.bind(this.catalogOperations)
    this.beginCatalogUpdate = this.catalogOperations.beginCatalogUpdate.bind(this.catalogOperations)
    this.catalogUpdatePreparation = this.catalogOperations.catalogUpdatePreparation.bind(this.catalogOperations)
    this.testCatalogUpdate = this.catalogOperations.testCatalogUpdate.bind(this.catalogOperations)
    this.finishCatalogUpdate = this.catalogOperations.finishCatalogUpdate.bind(this.catalogOperations)
    this.failCatalogUpdate = this.catalogOperations.failCatalogUpdate.bind(this.catalogOperations)
    this.importCatalog = this.catalogOperations.importCatalog.bind(this.catalogOperations)
    this.beginCatalogTest = this.catalogOperations.beginCatalogTest.bind(this.catalogOperations)
    this.failCatalogTest = this.catalogOperations.failCatalogTest.bind(this.catalogOperations)
    this.interruptCatalogTests = this.catalogOperations.interruptCatalogTests.bind(this.catalogOperations)
    this.catalogPreparation = this.catalogOperations.catalogPreparation.bind(this.catalogOperations)
  }
  /** Local policy versions are observable independently of account database facts. */
  version(): string | undefined {
    const store = this.store.view.version(),
      experts = this.experts ? this.experts.version?.() : 0,
      runtime = this.runtime ? this.runtime.version?.() : 0
    return store === undefined || experts === undefined || runtime === undefined ? undefined : `${store}:${experts}:${runtime}`
  }
  /** A request-local guard over local policy, independent of account database revisions. */
  captureLocalPolicy(): () => void {
    const snapshot = () => {
      const state = this.store.view.read()
      const experts = this.experts ? (this.experts.authorizationSnapshot?.() ?? this.experts.version?.()) : null
      if ((this.experts && experts === undefined) || (experts !== null && typeof experts === 'object' && 'then' in experts)) {
        throw new BusinessRuleError('forbidden', 'MCP authorization cannot be observed.', 'mcp-service-unavailable')
      }
      const prepared = state.services
        .flatMap(service => [service, ...(service.catalogUpdate?.candidate ? [service.catalogUpdate.candidate] : [])])
        .map(service => this.runtime?.ready(service) ?? null)
      return JSON.stringify([state, this.store.view.version(), experts, prepared])
    }
    const initial = snapshot()
    return () => {
      if (snapshot() !== initial) throw new BusinessRuleError('forbidden', 'MCP authorization changed during admission.', 'mcp-service-unavailable')
    }
  }
  async list(actor: CommunityAccountActor): Promise<readonly CommunityMcpSettings[]> {
    await this.assertAdmin(actor)
    return Promise.all((await this.store.read()).services.map(service => this.settings(service)))
  }
  observe(listener: () => void): () => void {
    this.observers.add(listener)
    return () => {
      this.observers.delete(listener)
    }
  }
  async effective(username: string): Promise<readonly McpService[]> {
    return this.prepared((await this.available(username)).filter(row => row.enabled).map(row => row.service))
  }
  async accessible(username: string): Promise<readonly McpService[]> {
    const acquired = combineAcquisitionSources([
      { source: 'managed', names: (await this.effective(username)).map(row => row.name) },
      { source: 'managed', names: await this.expertNames(username) },
    ])
    return this.prepared((await this.store.read()).services.filter(service => acquired.has(service.name)))
  }
  async expertProjection(username: string) {
    return { services: await this.accessible(username), global: (await this.effective(username)).map(row => row.name) }
  }
  private async expertNames(username: string): Promise<readonly string[]> {
    const account = await this.accounts.get(username)
    return account && !account.disabled && (await this.accounts.listGroups()).some(group => group.id === account.groupId)
      ? ((await this.experts?.mcp(username)) ?? [])
      : []
  }
  private prepared(services: readonly McpService[]): readonly McpService[] {
    return services.flatMap(service => {
      if (service.configurationRequired) return []
      if (service.catalog && service.catalog.status !== 'ready') return []
      const prepared = this.runtime?.ready(service)
      return !service.run ? [service] : prepared ? [{ ...service, prepared }] : []
    })
  }
  async memberDependencies(username: string) {
    const names = new Set([
      ...(await this.available(username)).filter(row => row.granted || row.enabled).map(row => row.service.name),
      ...(await this.expertNames(username)),
    ])
    return [
      ...new Map(
        (await this.store.read()).services
          .flatMap(service =>
            names.has(service.name) && service.run?.location === 'member' && (!service.catalog || service.catalog.status === 'ready')
              ? (this.runtime?.ready(service)?.dependencies ?? [])
              : [],
          )
          .map(row => [row.id, row]),
      ).values(),
    ]
  }
  async market(actor: CommunityAccountActor): Promise<readonly CommunityMarketMcp[]> {
    await this.assertMember(actor)
    return (await this.available(actor.username)).map(({ service, granted, enabled, required }) => ({
      name: service.name,
      description: mcpSettings(service).description,
      granted,
      enabled,
      required,
      tools: mcpSettings(service)
        .tools.filter(tool => !service.disabledTools?.includes(tool.name))
        .map(tool => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }) })),
    }))
  }
  toggle(actor: CommunityAccountActor, name: string, enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      await this.assertMember(actor)
      const row = (await this.available(actor.username)).find(row => row.service.name === name)
      if (!row) throw new BusinessRuleError('forbidden', 'MCP service is unavailable.', 'mcp-grant-invalid')
      if (row.required && !enabled) throw new BusinessRuleError('forbidden', 'This MCP service is required by your administrator.', 'mcp-required')
      const state = await this.store.read(),
        previous = state.selections?.[actor.spaceId] ?? []
      const selections = {
        ...state.selections,
        [actor.spaceId]: !row.granted && enabled ? [...new Set([...previous, name])] : enabled ? previous : previous.filter(value => value !== name),
      }
      const preferences = row.granted
        ? { ...state.preferences, [actor.spaceId]: { ...state.preferences?.[actor.spaceId], [name]: enabled } }
        : state.preferences
      await this.store.update(state, { ...state, selections, ...(preferences ? { preferences } : {}) })
      await this.synchronize()
    })
  }
  publish(actor: CommunityAccountActor, name: string, published: boolean): Promise<void> {
    return this.mutate(actor, async () => {
      const state = await this.store.read(),
        service = state.services.find(row => row.name === name)
      if (!service) throw new BusinessRuleError('missing', 'MCP service was not found.', 'not-found')
      if (published && (service.testStatus !== 'passed' || (service.catalog && service.catalog.status !== 'ready')))
        throw new BusinessRuleError('conflict', 'Test this MCP service successfully before publishing.', 'mcp-test-required')
      await this.store.update(state, {
        ...(published ? state : this.withoutSelections(state, name)),
        services: state.services.map(row => (row.name === name ? { ...row, published } : row)),
      })
    })
  }
  private async available(username: string) {
    const account = await this.accounts.get(username)
    if (!account || account.disabled) return []
    const group = (await this.accounts.listGroups()).find(row => row.id === account.groupId)
    if (!group) return []
    const state = await this.store.read(),
      names = new Set(Object.hasOwn(state.grants, group.id) ? state.grants[group.id] : [])
    const acquired = combineAcquisitionSources([
      { source: 'managed', names: state.services.filter(row => names.has(row.name)).map(row => row.name) },
      {
        source: 'selected',
        names: state.services.filter(row => row.published && state.selections?.[account.spaceId]?.includes(row.name)).map(row => row.name),
      },
    ])
    return state.services
      .filter(row => row.published || acquired.has(row.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(service => {
        const source = acquired.get(service.name)
        const granted = source === 'managed',
          required = granted && Boolean(service.required)
        const enabled = required || (granted ? (state.preferences?.[account.spaceId]?.[service.name] ?? true) : acquired.has(service.name))
        return { service, granted, required, enabled }
      })
  }
  private withoutSelections(state: import('../domain/mcp-service.js').McpState, name: string) {
    return {
      ...state,
      selections: Object.fromEntries(Object.entries(state.selections ?? {}).map(([id, names]) => [id, names.filter(value => value !== name)])),
    }
  }
  async group(actor: CommunityAccountActor, id: string): Promise<CommunityMcpGroup> {
    await this.assertAdmin(actor)
    requiredCommunityGroup(await this.accounts.listGroups(), id)
    const state = await this.store.read()
    const granted = new Set(Object.hasOwn(state.grants, id) ? state.grants[id] : [])
    return { groupId: id, services: state.services.map(row => ({ ...mcpSettings(row), granted: granted.has(row.name) })) }
  }
  save(actor: CommunityAccountActor, input: CommunityMcpInput, create = false, originalName?: string): Promise<void> {
    return this.mutate(actor, async () => {
      if (!input || typeof input !== 'object') throw new BusinessRuleError('invalid', 'Invalid MCP service.', 'mcp-service-invalid')
      const state = await this.store.read()
      if (create && state.services.some(row => row.name === input.name))
        throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
      if (state.services.some(row => row.catalogUpdate?.candidate?.name === input.name))
        throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
      const previous = state.services.find(item => item.name === (originalName ?? input.name))
      if (originalName !== undefined && (!previous || create)) throw new BusinessRuleError('missing', 'MCP service was not found.', 'not-found')
      if (originalName !== undefined && originalName !== input.name && state.services.some(row => row.name === input.name))
        throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
      const merged = mergeMcpInput(input, previous)
      if (previous) assertCatalogConfiguration(previous, merged)
      await this.runtime?.validateReferences?.(merged.run, previous?.run)
      const connectionChanged =
        !previous ||
        JSON.stringify(merged.run) !== JSON.stringify(previous.run ?? null) ||
        JSON.stringify(merged.credentials) !== JSON.stringify(previous.credentials ?? {}) ||
        previous.url !== merged.url ||
        merged.credential !== (previous.credential ?? '') ||
        JSON.stringify(merged.headers) !== JSON.stringify(previous.headers ?? []) ||
        JSON.stringify(merged.query) !== JSON.stringify(previous.query ?? [])
      const previousFields = { ...previous }
      delete previousFields.protectedValues
      delete previousFields.protectedCredentials
      if (!previous?.catalog) delete previousFields.configurationRequired
      const row: McpService = {
        ...previousFields,
        ...(merged.protectedValues?.length ? { protectedValues: merged.protectedValues } : {}),
        ...(merged.protectedCredentials?.length ? { protectedCredentials: merged.protectedCredentials } : {}),
        ...(previous?.catalogUpdate?.candidate ? { catalogUpdate: { ...previous.catalogUpdate, candidate: undefined, status: 'failed' as const } } : {}),
        run: merged.run ?? null,
        credentials: merged.credentials ?? {},
        required: merged.required ?? previous?.required ?? false,
        published: previous?.published ?? false,
        name: merged.name,
        description: merged.description,
        url: merged.url,
        generation: (state.revision ?? Math.max(0, ...state.services.map(service => service.generation))) + 1,
        credential: merged.credential ?? '',
        headers: merged.headers ?? [],
        query: merged.query ?? [],
        disabledTools: merged.disabledTools ?? previous?.disabledTools ?? [],
        testStatus: connectionChanged ? 'untested' : (previous?.testStatus ?? 'untested'),
      }
      if (previous?.catalog && (connectionChanged || ['testing', 'preparing'].includes(previous.catalog.status))) {
        Object.assign(row, { catalog: { ...previous.catalog, status: 'failed' } })
      }
      const rename = (name: string) => (name === previous?.name ? row.name : name)
      const renamed =
        previous && previous.name !== row.name
          ? {
              grants: Object.fromEntries(Object.entries(state.grants).map(([id, names]) => [id, names.map(rename)])),
              selections: Object.fromEntries(Object.entries(state.selections ?? {}).map(([id, names]) => [id, names.map(rename)])),
              preferences: Object.fromEntries(
                Object.entries(state.preferences ?? {}).map(([id, values]) => [
                  id,
                  Object.fromEntries(Object.entries(values).map(([name, enabled]) => [rename(name), enabled])),
                ]),
              ),
            }
          : {}
      await this.store.update(state, {
        ...state,
        ...renamed,
        revision: row.generation,
        services: [...state.services.filter(item => item.name !== (previous?.name ?? row.name)), row].sort((a, b) => a.name.localeCompare(b.name)),
      })
    })
  }
  async removalImpact(actor: CommunityAccountActor, name: string): Promise<McpRemovalImpact> {
    await this.assertAdmin(actor)
    return this.removal.impact(name)
  }
  remove(actor: CommunityAccountActor, name: string, revision?: string): Promise<void> {
    return this.mutate(actor, () => this.removal.remove(name, revision))
  }
  grant(actor: CommunityAccountActor, id: string, names: readonly string[]): Promise<void> {
    return this.mutate(actor, async () => {
      requiredCommunityGroup(await this.accounts.listGroups(), id)
      const state = await this.store.read(),
        available = new Set(state.services.map(row => row.name))
      if (!Array.isArray(names) || names.some(name => !available.has(name)))
        throw new BusinessRuleError('invalid', 'Select MCP services from the library.', 'mcp-grant-invalid')
      await this.store.update(state, { ...state, grants: { ...state.grants, [id]: [...new Set(names)].sort() } })
    })
  }
  async runtimeService(username: string, name: string, diagnostic: boolean): Promise<McpService | undefined> {
    if (!diagnostic) return (await this.accessible(username)).find(row => row.name === name)
    try {
      return await this.diagnostic(username, name)
    } catch (error) {
      // Runtime maintenance needs absence for confirmed ineligibility; the public
      // diagnostic endpoint retains its detailed errors. Uncertain reads still fail.
      if (error instanceof BusinessRuleError && ['not-found', 'admin-required', 'mcp-runtime-not-ready'].includes(error.code)) return undefined
      throw error
    }
  }
  async diagnostic(username: string, name: string): Promise<McpService> {
    const account = await this.accounts.get(username)
    if (!account || account.disabled || !account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
    const rows = (await this.store.read()).services
    const service = rows.find(row => row.name === name) ?? rows.find(row => row.catalogUpdate?.candidate?.name === name)?.catalogUpdate?.candidate
    if (!service) throw new BusinessRuleError('missing', 'MCP service was not found', 'not-found')
    if (service.configurationRequired)
      throw new BusinessRuleError('conflict', 'Reconfigure this MCP service after the platform secret reset.', 'mcp-runtime-not-ready')
    const prepared = this.runtime?.ready(service)
    if (service.run && !prepared) throw new BusinessRuleError('conflict', 'Prepare the MCP runtime before testing.', 'mcp-runtime-not-ready')
    return prepared ? { ...service, prepared } : service
  }
  recordTest(actor: CommunityAccountActor, name: string, generation: number, tools: readonly CommunityMcpTool[] | undefined): Promise<void> {
    return this.mutate(actor, async () => {
      const state = await this.store.read(),
        previous = state.services.find(row => row.name === name)
      if (!previous || previous.generation !== generation)
        throw new BusinessRuleError('conflict', 'MCP settings changed during the test. Test the saved settings again.', 'mcp-test-stale')
      const known = new Set(previous.tools?.map(row => row.name) ?? [])
      const next = {
        ...previous,
        ...(previous.catalog ? { catalog: { ...previous.catalog, status: tools ? ('ready' as const) : ('failed' as const) } } : {}),
        testStatus: tools ? ('passed' as const) : ('failed' as const),
        tools:
          (tools ? (redactMcpValue(tools, mcpSecrets(previous)) as readonly CommunityMcpTool[]) : undefined)?.map(row => ({
            ...row,
            isNew: !known.has(row.name),
          })) ??
          previous.tools ??
          [],
      }
      await this.store.update(state, { ...state, services: state.services.map(row => (row.name === name ? next : row)) })
    })
  }
  async reprepare(actor: CommunityAccountActor, name: string): Promise<void> {
    await this.assertAdmin(actor)
    const service = (await this.store.read()).services.find(row => row.name === name)
    if (!service?.run || !this.runtime) throw new BusinessRuleError('conflict', 'Prepare the MCP runtime before testing.', 'mcp-runtime-not-ready')
    this.runtime.restart(name)
  }
  private async settings(service: McpService): Promise<CommunityMcpSettings> {
    const preparation = this.runtime?.readView ? await this.runtime.readView(service) : this.runtime?.view(service)
    const available = this.presets.find(row => row.entry.id === service.catalog?.id)?.entry.version
    return {
      ...mcpSettings(service),
      ...(available && (service.configurationRequired || available !== service.catalog?.version) ? { availableCatalogVersion: available } : {}),
      ...(preparation ? { preparation: { ...preparation, log: String(redactMcpValue(preparation.log, mcpSecrets(service))) } } : {}),
    }
  }
  prepare(): Promise<void> {
    return this.enqueue(async () => {
      const snapshot = await this.preparationSnapshot()
      if (snapshot !== undefined && snapshot === this.preparedSnapshot) return
      await this.synchronizeCurrent()
    })
  }
  private async preparationSnapshot(): Promise<string | undefined> {
    try {
      const runtime = this.runtime ? (this.runtime.preparationSnapshot ? this.runtime.preparationSnapshot() : this.runtime.version?.()) : 0,
        experts = this.experts ? this.experts.version?.() : 0
      if (runtime === undefined || experts === undefined) return undefined
      return JSON.stringify([
        this.store.view.version(),
        runtime,
        experts,
        (await this.accounts.list()).map(row => [row.username, row.spaceId, row.groupId, row.disabled]).sort(),
        await this.accounts.listGroups(),
      ])
    } catch (error) {
      // An uncertain cache key disables reuse; it is never an authorization fact.
      if (error instanceof PlatformDatabaseError && error.code === 'unavailable') return undefined
      throw error
    }
  }
  recover(): Promise<void> {
    return this.enqueue(() => this.synchronizeCurrent())
  }
  async stop(): Promise<void> {
    this.stopping = true
    this.shutdown.abort()
    await this.pending
  }
  private mutate(actor: CommunityAccountActor, update: () => void | Promise<void>, waitForPublication = true): Promise<void> {
    return this.enqueue(async () => {
      await this.assertAdmin(actor)
      await update()
      // Catalog operations own durable pending intents and their publication retry.
      if (waitForPublication) await this.synchronizeCurrent()
      else await this.synchronize()
    })
  }
  private async synchronizeCurrent(): Promise<void> {
    for (;;) {
      try {
        await this.synchronize()
        return
      } catch (error) {
        if (!(error instanceof PlatformDatabaseError) || error.code !== 'unavailable' || this.stopping) throw error
        await delay(250, undefined, { signal: this.shutdown.signal, ref: false })
      }
    }
  }
  private async synchronize(): Promise<void> {
    const snapshot = await this.preparationSnapshot()
    this.preparedSnapshot = undefined
    try {
      await this.store.reconcile(this.runtime)
      await this.runtime?.changed()
      await this.projection.synchronize(
        await Promise.all(
          (await this.accounts.list()).map(async account => ({
            username: account.username,
            spaceId: account.spaceId,
            services: await this.effective(account.username),
          })),
        ),
      )
      await this.afterProjection()
      if (snapshot === (await this.preparationSnapshot())) this.preparedSnapshot = snapshot
    } finally {
      for (const observer of this.observers) observer()
    }
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    if (this.stopping) return Promise.reject(new BusinessRuleError('conflict', 'MCP service management is stopping.', 'mcp-service-unavailable'))
    const next = this.pending.then(run)
    this.pending = next.catch(() => undefined)
    return next
  }
  private async assertMember(actor: CommunityAccountActor) {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
  private async assertAdmin(actor: CommunityAccountActor): Promise<void> {
    const account = await this.assertMember(actor)
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
