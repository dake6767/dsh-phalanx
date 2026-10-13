import type { CommunityMcpCatalogInput } from '../domain/admin-contract.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { McpServices } from './mcp-services.js'
import type { McpConnectionTest } from './mcp-connection-test.js'

/** Owns background import tests; McpServices remains the only durable state writer. */
export class McpCatalogImports {
  private readonly shutdown = new AbortController()
  private readonly jobs = new Map<number, Promise<void>>()
  constructor(private readonly services: McpServices, private readonly test: McpConnectionTest) {}
  async import(actor: CommunityAccountActor, input: CommunityMcpCatalogInput): Promise<void> {
    const operation = await this.services.importCatalog(actor, input)
    if (operation.testing) this.start(actor, operation.name, operation.generation)
  }
  async retry(actor: CommunityAccountActor, name: string): Promise<void> {
    const generation = await this.services.beginCatalogTest(actor, name)
    this.start(actor, name, generation)
  }
  private start(actor: CommunityAccountActor, name: string, generation: number): void {
    if (this.jobs.has(generation)) return
    const job = this.prepared(actor, name, generation).then(async () => { await this.services.beginCatalogTest(actor, name, generation); await this.test.execute(actor, name, generation) })
      .catch(() => this.services.failCatalogTest(name, generation)).catch(() => undefined).finally(() => { this.jobs.delete(generation) })
    this.jobs.set(generation, job)
  }
  private prepared(actor: CommunityAccountActor, name: string, generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => { unobserve(); this.shutdown.signal.removeEventListener('abort', aborted); if (error) reject(error); else resolve() }
      const check = () => { try { if (this.services.catalogPreparation(actor, name, generation) === 'ready') finish() } catch (error) { finish(error) } }
      const aborted = () => finish(new Error('MCP import stopped'))
      const unobserve = this.services.observe(check)
      this.shutdown.signal.addEventListener('abort', aborted, { once: true })
      if (this.shutdown.signal.aborted) aborted(); else check()
    })
  }
  async stop(): Promise<void> { this.shutdown.abort(); await this.drain() }
  async drain(): Promise<void> { await Promise.allSettled(this.jobs.values()) }
}
