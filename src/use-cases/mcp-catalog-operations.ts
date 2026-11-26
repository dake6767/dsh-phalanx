import { mcpSecrets, redactMcpValue } from '../domain/mcp-protocol.js'
import { consistentMcpPresets, mcpCatalogTarget, reusableMcpCatalogCredential } from '../domain/mcp-catalog-identity.js'
import { catalogInput, type McpCatalogSnapshot, type McpPreset } from '../domain/mcp-catalog.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { PlatformDatabaseError } from '../domain/platform-database.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { mcpSettings, validateMcpSettings, type McpService } from '../domain/mcp-service.js'
import type { CommunityMcpCatalogInput, CommunityMcpSettings, CommunityMcpTool } from '../domain/admin-contract.js'
import type { McpStatePort, McpRuntimePort } from '../ports/mcp-services.js'

interface McpCatalogLifecycle {
  assertAdmin(actor: CommunityAccountActor): Promise<void>
  mutate(actor: CommunityAccountActor, update: () => void | Promise<void>): Promise<void>
  enqueue(update: () => Promise<void>): Promise<void>
  synchronize(): Promise<void>
}

/** Catalog intents share the service owner's queue, projection and stopping boundary. */
export class McpCatalogOperations {
  constructor(
    private readonly store: McpStatePort,
    private readonly loadCatalog: () => Promise<McpCatalogSnapshot>,
    private readonly lifecycle: McpCatalogLifecycle,
    private readonly runtime?: McpRuntimePort,
  ) {}
  async list(actor: CommunityAccountActor, includeCatalogTargets = true): Promise<readonly CommunityMcpSettings[]> {
    await this.lifecycle.assertAdmin(actor)
    const { services } = await this.store.read()
    const presets =
      includeCatalogTargets && services.some(service => service.catalog) ? consistentMcpPresets((await this.loadCatalog()).presets, services) : undefined
    return Promise.all(services.map(service => this.settings(service, presets)))
  }
  private async settings(service: McpService, presets: readonly McpPreset[] | undefined): Promise<CommunityMcpSettings> {
    const preparation = this.runtime?.readView ? await this.runtime.readView(service) : this.runtime?.view(service)
    const preset = presets?.find(row => row.entry.id === service.catalog?.id)
    const target = await this.target(service, preset)
    return {
      ...mcpSettings(service),
      ...(target === 'update' && preset ? { availableCatalogVersion: preset.entry.version } : {}),
      ...(presets && service.catalog && target === 'unavailable' ? { catalogTargetUnavailable: true } : {}),
      ...(preparation ? { preparation: { ...preparation, log: String(redactMcpValue(preparation.log, mcpSecrets(service))) } } : {}),
    }
  }
  private async target(service: McpService, preset: McpPreset | undefined) {
    const dependency =
      service.dependencyName && service.catalog?.version === '1' && preset?.entry.version === '1.0.0'
        ? await this.runtime?.readCatalogDependency?.(service.dependencyName)
        : undefined
    return mcpCatalogTarget(service, preset, dependency)
  }
  async catalog(actor: CommunityAccountActor): Promise<import('../domain/admin-contract.js').CommunityMcpCatalogView> {
    await this.lifecycle.assertAdmin(actor)
    const services = (await this.store.read()).services
    const { presets, source, galleryTags } = await this.loadCatalog()
    return {
      source,
      entries: consistentMcpPresets(presets, services).map(({ entry }) => ({
        ...entry,
        imported: services.filter(service => service.catalog?.id === entry.id).length,
      })),
      ...(galleryTags ? { galleryTags } : {}),
    }
  }
  async catalogUpdatePreview(actor: CommunityAccountActor, name: string): Promise<import('../domain/admin-contract.js').CommunityMcpCatalogUpdatePreview> {
    await this.lifecycle.assertAdmin(actor)
    const [{ services }, { presets }] = await Promise.all([this.store.read(), this.loadCatalog()])
    const service = services.find(row => row.name === name)
    const preset = consistentMcpPresets(presets, services).find(row => row.entry.id === service?.catalog?.id)
    if (!service?.catalog) throw new BusinessRuleError('missing', 'MCP catalog service was not found.', 'not-found')
    if (!preset) throw unavailable()
    const target = await this.target(service, preset)
    if (target === 'unavailable') throw unavailable()
    if (target === 'current' && service.catalog.version !== preset.entry.version)
      throw new BusinessRuleError('conflict', 'MCP settings changed during the test.', 'mcp-test-stale')
    const fields = ['description', 'url', 'run', 'headers', 'query'] as const
    const reusable = reusableMcpCatalogCredential(service, preset)
    const { credentialLabel, credentialOptional } = preset.entry
    return {
      currentVersion: service.catalog.version,
      version: preset.entry.version,
      ...(preset.entry.contentHash ? { contentHash: preset.entry.contentHash } : {}),
      credentialRequired: Boolean(credentialLabel && !credentialOptional && !reusable),
      ...(credentialOptional ? { credentialOptional } : {}),
      ...(credentialOptional && service.credential && !reusable ? { credentialWillBeDropped: true } : {}),
      changes: fields.flatMap(field => {
        const before = JSON.stringify(mcpSettings(service)[field] ?? null),
          after = JSON.stringify(mcpSettings({ ...preset.configuration, name: service.name, generation: service.generation })[field] ?? null)
        return before === after ? [] : [{ field, before, after }]
      }),
    }
  }
  async beginCatalogUpdate(
    actor: CommunityAccountActor,
    input: import('../domain/admin-contract.js').CommunityMcpCatalogUpdateInput,
  ): Promise<{ name: string; pending: boolean }> {
    if (!input || Object.keys(input).some(key => !['name', 'version', 'requestId', 'credential', 'contentHash'].includes(key)))
      throw new BusinessRuleError('invalid', 'Invalid MCP catalog input.', 'mcp-service-invalid')
    const presets = await this.presetsForRequest(actor, input.requestId)
    let operation: { name: string; pending: boolean } | undefined
    try {
      await this.lifecycle.mutate(actor, async () => {
        const state = await this.store.read(),
          previous = state.services.find(row => row.name === input.name)
        if (!previous?.catalog) throw new BusinessRuleError('missing', 'MCP catalog service was not found.', 'not-found')
        if (state.catalogRequests?.includes(input.requestId)) {
          if (previous.catalogUpdate?.requestId !== input.requestId)
            throw new BusinessRuleError('conflict', 'This import was removed. Start a new import.', 'mcp-import-retired')
          operation = { name: previous.catalogUpdate.name, pending: Boolean(previous.catalogUpdate.candidate) }
          return
        }
        const preset = consistentMcpPresets(presets, state.services).find(row => row.entry.id === previous.catalog!.id)
        if (!preset) throw unavailable()
        const target = await this.target(previous, preset)
        if (target === 'unavailable') throw unavailable()
        if (
          input.version !== preset.entry.version ||
          input.contentHash !== preset.entry.contentHash ||
          target !== 'update' ||
          (!previous.configurationRequired && previous.catalog.status !== 'ready') ||
          previous.catalogUpdate?.candidate
        )
          throw new BusinessRuleError('conflict', 'MCP settings changed during the test.', 'mcp-test-stale')
        const generation = Math.max(state.revision ?? 0, ...state.services.map(row => row.generation)) + 1,
          name = `p-update-${generation}`
        if (state.services.some(row => row.name === name))
          throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
        const settings = catalogInput(
          {
            presetId: previous.catalog.id,
            name,
            credential: input.credential ?? reusableMcpCatalogCredential(previous, preset) ?? '',
            requestId: input.requestId,
          },
          [preset],
        )
        validateMcpSettings(settings)
        const status = settings.run ? ('preparing' as const) : ('testing' as const)
        const candidate: McpService = {
          ...settings,
          ...(previous.dependencyName ? { dependencyTarget: previous.dependencyName } : {}),
          preparationName: `catalog-update:${generation}`,
          generation,
          catalog: {
            id: previous.catalog.id,
            version: input.version,
            ...(preset.entry.contentHash ? { contentHash: preset.entry.contentHash } : {}),
            ...(preset.entry.credentialOptional ? { credentialOptional: true } : {}),
            status,
          },
          testStatus: 'untested',
        }
        const catalogUpdate = { name, requestId: input.requestId, version: input.version, baseGeneration: previous.generation, actor, status, candidate }
        await this.store.update(state, {
          ...state,
          revision: generation,
          catalogRequests: [...(state.catalogRequests ?? []), input.requestId],
          services: state.services.map(row => (row === previous ? { ...row, catalogUpdate } : row)),
        })
        operation = { name, pending: true }
      })
    } catch (error) {
      if (operation?.pending && error instanceof PlatformDatabaseError && error.code === 'unavailable') return operation
      if (operation?.pending) await this.failCatalogUpdate(operation.name).catch(() => {})
      throw error
    }
    return operation!
  }
  private async currentCatalogUpdate(actor: CommunityAccountActor, name: string) {
    await this.lifecycle.assertAdmin(actor)
    const state = await this.store.read(),
      service = state.services.find(row => row.catalogUpdate?.name === name),
      update = service?.catalogUpdate
    if (
      !service ||
      !update?.candidate ||
      service.generation !== update.baseGeneration ||
      update.actor.username !== actor.username ||
      update.actor.spaceId !== actor.spaceId ||
      update.actor.sessionEpoch !== actor.sessionEpoch
    )
      throw new BusinessRuleError('conflict', 'MCP settings changed during the test.', 'mcp-test-stale')
    return { state, service, update, candidate: update.candidate }
  }
  private preparationIdentity(service: McpService): string {
    const prepared = this.runtime?.ready(service)
    return JSON.stringify([prepared?.directory, prepared?.dependencies?.map(row => row.id)])
  }
  async catalogUpdatePreparation(actor: CommunityAccountActor, name: string): Promise<'ready' | 'waiting'> {
    const { candidate } = await this.currentCatalogUpdate(actor, name)
    if (!candidate.run || this.runtime?.ready(candidate)) return 'ready'
    if (this.runtime?.view(candidate)?.stage === 'failed') throw new BusinessRuleError('conflict', 'MCP preparation failed.', 'mcp-runtime-not-ready')
    return 'waiting'
  }
  testCatalogUpdate(actor: CommunityAccountActor, name: string): Promise<void> {
    return this.lifecycle.mutate(actor, async () => {
      const { state, service, update } = await this.currentCatalogUpdate(actor, name)
      if ((await this.catalogUpdatePreparation(actor, name)) !== 'ready')
        throw new BusinessRuleError('conflict', 'MCP preparation failed.', 'mcp-runtime-not-ready')
      await this.store.update(state, {
        ...state,
        services: state.services.map(row =>
          row === service ? { ...row, catalogUpdate: { ...update, testedPreparation: this.preparationIdentity(update.candidate!), status: 'testing' } } : row,
        ),
      })
    })
  }
  finishCatalogUpdate(actor: CommunityAccountActor, name: string, tools: readonly CommunityMcpTool[] | undefined): Promise<void> {
    return this.lifecycle.mutate(actor, async () => {
      const { state, service, update, candidate } = await this.currentCatalogUpdate(actor, name)
      if (!tools) {
        await this.store.update(state, {
          ...state,
          services: state.services.map(row => (row === service ? { ...row, catalogUpdate: { ...update, candidate: undefined, status: 'failed' } } : row)),
        })
        return
      }
      if (update.testedPreparation !== this.preparationIdentity(candidate))
        throw new BusinessRuleError('conflict', 'MCP dependencies changed during the test.', 'mcp-test-stale')
      const selected = this.runtime?.promote?.(candidate, service) ?? candidate
      const { credential, ...saved } = service
      void credential
      const next: McpService = {
        ...saved,
        ...selected,
        name: service.name,
        display: {
          ...(selected.display?.defaults ? { defaults: selected.display.defaults } : {}),
          ...(service.display?.name === undefined ? {} : { name: service.display.name }),
          ...(service.display?.description === undefined ? {} : { description: service.display.description }),
        },
        published: service.published ?? false,
        required: service.required ?? false,
        disabledTools: service.disabledTools ?? [],
        ...(service.catalogRequestId ? { catalogRequestId: service.catalogRequestId } : {}),
        catalog: { ...candidate.catalog!, status: 'ready' },
        testStatus: 'passed',
        tools,
        catalogUpdate: { ...update, candidate: undefined, status: 'applied' },
      }
      const { configurationRequired, ...restored } = next
      void configurationRequired
      await this.store.update(state, { ...state, services: state.services.map(row => (row === service ? restored : row)) })
    })
  }
  failCatalogUpdate(name: string): Promise<void> {
    return this.lifecycle.enqueue(async () => {
      const state = await this.store.read()
      await this.store.update(state, {
        ...state,
        services: state.services.map(row =>
          row.catalogUpdate?.name === name && row.catalogUpdate.candidate
            ? { ...row, catalogUpdate: { ...row.catalogUpdate, candidate: undefined, status: 'failed' } }
            : row,
        ),
      })
      await this.lifecycle.synchronize()
    })
  }
  private async presetsForRequest(actor: CommunityAccountActor, requestId: string): Promise<readonly McpPreset[]> {
    await this.lifecycle.assertAdmin(actor)
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(requestId))
      throw new BusinessRuleError('invalid', 'Invalid MCP catalog input.', 'mcp-service-invalid')
    if ((await this.store.read()).catalogRequests?.includes(requestId)) return []
    return (await this.loadCatalog()).presets
  }
  async importCatalog(actor: CommunityAccountActor, input: CommunityMcpCatalogInput) {
    const presets = await this.presetsForRequest(actor, input?.requestId)
    return this.catalogMutation(actor, async () => {
      const state = await this.store.read()
      if (state.catalogRequests?.includes(input.requestId)) {
        const existing = state.services.find(row => row.catalogRequestId === input.requestId)
        if (!existing) throw new BusinessRuleError('conflict', 'This import was removed. Start a new import.', 'mcp-import-retired')
        return existing
      }
      const preset = consistentMcpPresets(presets, state.services).find(row => row.entry.id === input.presetId)
      if (!preset) throw unavailable()
      if (preset.entry.contentHash && (input.version !== preset.entry.version || input.contentHash !== preset.entry.contentHash))
        throw new BusinessRuleError('conflict', 'MCP catalog entry changed.', 'mcp-test-stale')
      const settings = catalogInput(input, [preset])
      validateMcpSettings(settings)
      if (state.services.some(row => row.name === input.name || row.catalogUpdate?.candidate?.name === input.name))
        throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
      const generation = Math.max(state.revision ?? 0, ...state.services.map(row => row.generation)) + 1
      const service: McpService = {
        ...settings,
        generation,
        published: false,
        required: false,
        testStatus: 'untested',
        catalogRequestId: input.requestId,
        catalog: {
          id: input.presetId,
          version: preset.entry.version,
          ...(preset.entry.contentHash ? { contentHash: preset.entry.contentHash } : {}),
          ...(preset.entry.credentialOptional ? { credentialOptional: true } : {}),
          status: settings.run ? 'preparing' : 'testing',
        },
      }
      await this.store.update(state, {
        ...state,
        revision: generation,
        catalogRequests: [...(state.catalogRequests ?? []), input.requestId],
        services: [...state.services, service],
      })
      return service
    })
  }
  async beginCatalogTest(actor: CommunityAccountActor, name: string, expectedGeneration?: number): Promise<number> {
    const operation = await this.catalogMutation(actor, async () => {
      const state = await this.store.read(),
        service = state.services.find(row => row.name === name)
      if (!service?.catalog) throw new BusinessRuleError('missing', 'MCP catalog service was not found.', 'not-found')
      if (expectedGeneration !== undefined && service.generation !== expectedGeneration)
        throw new BusinessRuleError('conflict', 'MCP settings changed during preparation.', 'mcp-test-stale')
      if (service.run && this.runtime?.view(service)?.stage === 'failed') this.runtime.restart(name)
      const next: McpService = { ...service, catalog: { ...service.catalog, status: service.run && !this.runtime?.ready(service) ? 'preparing' : 'testing' } }
      await this.store.update(state, { ...state, services: state.services.map(row => (row === service ? next : row)) })
      return next
    })
    return operation.generation
  }
  private async catalogMutation(actor: CommunityAccountActor, change: () => McpService | Promise<McpService>) {
    let service: McpService | undefined
    try {
      await this.lifecycle.mutate(actor, async () => {
        service = await change()
      })
    } catch (error) {
      // Persistence precedes projection: even a failed handoff must leave a retryable row.
      if (!service || !(error instanceof PlatformDatabaseError) || error.code !== 'unavailable') {
        if (service) await this.failCatalogTest(service.name, service.generation).catch(() => undefined)
        throw error
      }
    }
    return { name: service!.name, generation: service!.generation, testing: service!.catalog?.status === 'testing' || service!.catalog?.status === 'preparing' }
  }
  failCatalogTest(name: string, generation: number): Promise<void> {
    return this.lifecycle.enqueue(async () => {
      const state = await this.store.read()
      await this.store.update(state, {
        ...state,
        services: state.services.map(row =>
          row.name === name && row.generation === generation && (row.catalog?.status === 'testing' || row.catalog?.status === 'preparing')
            ? { ...row, testStatus: 'failed', catalog: { ...row.catalog, status: 'failed' } }
            : row,
        ),
      })
      await this.lifecycle.synchronize()
    })
  }
  interruptCatalogTests(): Promise<void> {
    return this.lifecycle.enqueue(async () => {
      const state = await this.store.read()
      await this.store.update(state, {
        ...state,
        services: state.services.map(row => ({
          ...row,
          ...(row.catalogUpdate?.candidate ? { catalogUpdate: { ...row.catalogUpdate, candidate: undefined, status: 'failed' as const } } : {}),
          ...(row.catalog?.status === 'testing' || row.catalog?.status === 'preparing'
            ? { testStatus: 'failed' as const, catalog: { ...row.catalog, status: 'failed' as const } }
            : {}),
        })),
      })
      await this.lifecycle.synchronize()
    })
  }
  async catalogPreparation(actor: CommunityAccountActor, name: string, generation: number): Promise<'ready' | 'waiting'> {
    await this.lifecycle.assertAdmin(actor)
    const service = (await this.store.read()).services.find(row => row.name === name)
    if (!service || service.generation !== generation) throw new BusinessRuleError('conflict', 'MCP settings changed during preparation.', 'mcp-test-stale')
    if (!service.run || this.runtime?.ready(service)) return 'ready'
    if (this.runtime?.view(service)?.stage === 'failed') throw new BusinessRuleError('conflict', 'MCP preparation failed.', 'mcp-runtime-not-ready')
    return 'waiting'
  }
}

function unavailable(): BusinessRuleError {
  return new BusinessRuleError('conflict', 'MCP catalog target is unavailable.', 'mcp-catalog-unavailable')
}
