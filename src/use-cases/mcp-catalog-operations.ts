import { catalogInput, type McpPreset } from '../domain/mcp-catalog.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { PlatformDatabaseError } from '../domain/platform-database.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { mcpSettings, validateMcpSettings, type McpService } from '../domain/mcp-service.js'
import type { CommunityMcpCatalogInput, CommunityMcpTool } from '../domain/admin-contract.js'
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
    private readonly presets: readonly McpPreset[],
    private readonly lifecycle: McpCatalogLifecycle,
    private readonly runtime?: McpRuntimePort,
  ) {}
  async catalog(actor: CommunityAccountActor) {
    await this.lifecycle.assertAdmin(actor)
    const services = (await this.store.read()).services
    return this.presets.map(({ entry }) => ({ ...entry, imported: services.filter(service => service.catalog?.id === entry.id).length }))
  }
  async catalogUpdatePreview(actor: CommunityAccountActor, name: string): Promise<import('../domain/admin-contract.js').CommunityMcpCatalogUpdatePreview> {
    await this.lifecycle.assertAdmin(actor)
    const service = (await this.store.read()).services.find(row => row.name === name)
    const preset = this.presets.find(row => row.entry.id === service?.catalog?.id)
    if (!service?.catalog || !preset) throw new BusinessRuleError('missing', 'MCP catalog service was not found.', 'not-found')
    const fields = ['description', 'url', 'run', 'headers', 'query'] as const
    return {
      currentVersion: service.catalog.version,
      version: preset.entry.version,
      credentialRequired: Boolean(preset.entry.credentialLabel && !service.credential),
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
    let operation: { name: string; pending: boolean } | undefined
    try {
      await this.lifecycle.mutate(actor, async () => {
        if (
          !input ||
          Object.keys(input).some(key => !['name', 'version', 'requestId', 'credential'].includes(key)) ||
          typeof input.requestId !== 'string' ||
          !/^[A-Za-z0-9_-]{16,128}$/u.test(input.requestId)
        )
          throw new BusinessRuleError('invalid', 'Invalid MCP catalog input.', 'mcp-service-invalid')
        const state = await this.store.read(),
          previous = state.services.find(row => row.name === input.name)
        if (!previous?.catalog) throw new BusinessRuleError('missing', 'MCP catalog service was not found.', 'not-found')
        if (state.catalogRequests?.includes(input.requestId)) {
          if (previous.catalogUpdate?.requestId !== input.requestId)
            throw new BusinessRuleError('conflict', 'This import was removed. Start a new import.', 'mcp-import-retired')
          operation = { name: previous.catalogUpdate.name, pending: Boolean(previous.catalogUpdate.candidate) }
          return
        }
        const preset = this.presets.find(row => row.entry.id === previous.catalog!.id)
        if (
          !preset ||
          input.version !== preset.entry.version ||
          (!previous.configurationRequired && (previous.catalog.version === input.version || previous.catalog.status !== 'ready')) ||
          previous.catalogUpdate?.candidate
        )
          throw new BusinessRuleError('conflict', 'MCP settings changed during the test.', 'mcp-test-stale')
        const generation = Math.max(state.revision ?? 0, ...state.services.map(row => row.generation)) + 1,
          name = `p-update-${generation}`
        if (state.services.some(row => row.name === name))
          throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
        const settings = catalogInput(
          { presetId: previous.catalog.id, name, credential: input.credential ?? previous.credential ?? '', requestId: input.requestId },
          this.presets,
        )
        validateMcpSettings(settings)
        const status = settings.run ? ('preparing' as const) : ('testing' as const)
        const candidate: McpService = {
          ...settings,
          ...(previous.dependencyName ? { dependencyTarget: previous.dependencyName } : {}),
          preparationName: `catalog-update:${generation}`,
          generation,
          catalog: { id: previous.catalog.id, version: input.version, status },
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
      const next: McpService = {
        ...service,
        ...selected,
        name: service.name,
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
  importCatalog(actor: CommunityAccountActor, input: CommunityMcpCatalogInput) {
    return this.catalogMutation(actor, async () => {
      const settings = catalogInput(input, this.presets)
      validateMcpSettings(settings)
      const state = await this.store.read()
      if (state.catalogRequests?.includes(input.requestId)) {
        const existing = state.services.find(row => row.catalogRequestId === input.requestId)
        if (!existing) throw new BusinessRuleError('conflict', 'This import was removed. Start a new import.', 'mcp-import-retired')
        return existing
      }
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
          version: this.presets.find(row => row.entry.id === input.presetId)!.entry.version,
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
