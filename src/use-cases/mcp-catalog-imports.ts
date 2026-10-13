import type { CommunityMcpCatalogInput } from '../domain/admin-contract.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { McpServices } from './mcp-services.js'
import type { McpConnectionTest } from './mcp-connection-test.js'

/** Owns background import tests; McpServices remains the only durable state writer. */
export class McpCatalogImports {
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
    const job = this.test.execute(actor, name, generation).then(() => undefined)
      .catch(() => this.services.failCatalogTest(name, generation)).catch(() => undefined).finally(() => { this.jobs.delete(generation) })
    this.jobs.set(generation, job)
  }
  async drain(): Promise<void> { await Promise.allSettled(this.jobs.values()) }
}
