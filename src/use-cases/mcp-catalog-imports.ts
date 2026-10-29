import type { CommunityMcpCatalogInput } from '../domain/admin-contract.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { McpServices } from './mcp-services.js'
import type { McpConnectionTest } from './mcp-connection-test.js'
import { PlatformDatabaseError } from '../domain/platform-database.js'

/** Owns background import and candidate validation; McpServices remains the only durable state writer. */
export class McpCatalogImports {
  private readonly shutdown = new AbortController()
  private readonly jobs = new Map<number | string, Promise<void>>()
  private readonly inspections = new Set<Promise<void>>()
  constructor(
    private readonly services: McpServices,
    private readonly test: McpConnectionTest,
    private readonly probe?: import('../ports/mcp-services.js').McpProbePort,
  ) {}
  async import(actor: CommunityAccountActor, input: CommunityMcpCatalogInput): Promise<void> {
    const operation = await this.services.importCatalog(actor, input)
    if (operation.testing) this.start(actor, operation.name, operation.generation)
  }
  async retry(actor: CommunityAccountActor, name: string): Promise<void> {
    const generation = await this.services.beginCatalogTest(actor, name)
    this.start(actor, name, generation)
  }
  async update(actor: CommunityAccountActor, input: import('../domain/admin-contract.js').CommunityMcpCatalogUpdateInput): Promise<void> {
    const operation = await this.services.beginCatalogUpdate(actor, input)
    if (!operation.pending || this.jobs.has(operation.name)) return
    const job = this.waitFor(async () => {
      if ((await this.services.catalogUpdatePreparation(actor, operation.name)) !== 'ready') return 'waiting'
      this.shutdown.signal.throwIfAborted()
      await this.services.testCatalogUpdate(actor, operation.name)
      return 'ready'
    })
      .then(async () => {
        if (!this.probe) throw new Error('MCP update diagnostics unavailable')
        const tools = await this.probe.probe(actor.username, actor.spaceId, operation.name)
        await this.services.finishCatalogUpdate(actor, operation.name, tools)
      })
      .catch(() => this.services.failCatalogUpdate(operation.name))
      .catch(() => undefined)
      .finally(() => {
        this.jobs.delete(operation.name)
      })
    this.jobs.set(operation.name, job)
  }
  private start(actor: CommunityAccountActor, name: string, generation: number): void {
    if (this.jobs.has(generation)) return
    const job = this.waitFor(async () => {
      if ((await this.services.catalogPreparation(actor, name, generation)) !== 'ready') return 'waiting'
      this.shutdown.signal.throwIfAborted()
      await this.services.beginCatalogTest(actor, name, generation)
      return 'ready'
    })
      .then(async () => {
        await this.test.execute(actor, name, generation)
      })
      .catch(() => this.services.failCatalogTest(name, generation))
      .catch(() => undefined)
      .finally(() => {
        this.jobs.delete(generation)
      })
    this.jobs.set(generation, job)
  }
  private waitFor(state: () => Promise<'ready' | 'waiting'>): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false,
        checking = false,
        pending = false
      let retry: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(retry)
        unobserve()
        this.shutdown.signal.removeEventListener('abort', aborted)
        if (error) reject(error)
        else resolve()
      }
      const inspect = async () => {
        if (settled) return
        if (checking) {
          pending = true
          return
        }
        checking = true
        clearTimeout(retry)
        retry = undefined
        try {
          do {
            pending = false
            if ((await state()) === 'ready') {
              finish()
              break
            }
          } while (pending && !settled)
        } catch (error) {
          if (settled) return
          if (error instanceof PlatformDatabaseError && error.code === 'unavailable') {
            // A committed view can be refreshing without another projection event.
            // Keep one cancellable recheck; uncertain readiness is not preparation failure.
            retry = setTimeout(check, 250)
            retry.unref()
          } else finish(error)
        } finally {
          checking = false
        }
      }
      const check = () => {
        const inspection = inspect()
        this.inspections.add(inspection)
        void inspection.finally(() => this.inspections.delete(inspection))
      }
      const aborted = () => finish(new Error('MCP import stopped'))
      const unobserve = this.services.observe(check)
      this.shutdown.signal.addEventListener('abort', aborted, { once: true })
      if (this.shutdown.signal.aborted) aborted()
      else check()
    })
  }
  async stop(): Promise<void> {
    this.shutdown.abort()
    await this.drain()
    await Promise.allSettled(this.inspections)
  }
  async drain(): Promise<void> {
    await Promise.allSettled(this.jobs.values())
  }
}
