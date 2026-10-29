import type { PlatformDatabaseConnection } from '../domain/platform-database.js'
import type { BootstrapCredentialPort } from '../ports/bootstrap-credential.js'
import type { BootstrapDatabasePort } from '../ports/bootstrap-database.js'
import { BusinessRuleError } from '../domain/business-error.js'

/** Serializes first-install selection and activation behind the outstanding invitation. */
export class CommunityDatabaseOnboarding {
  private selecting: Promise<void> = Promise.resolve()
  private readonly operations = new Set<Promise<unknown>>()
  private closed = false
  constructor(
    private readonly credential: BootstrapCredentialPort,
    private readonly storage: BootstrapDatabasePort,
    private readonly activate: () => Promise<void>,
    private readonly onFailed: () => void,
  ) {}
  pending(): boolean {
    return this.storage.pending()
  }
  private authorize(value: string): void {
    if (this.closed) throw new BusinessRuleError('conflict', 'Database setup is closed', 'database-setup-closed')
    if (!this.credential.verify(value)) throw new BusinessRuleError('forbidden', 'Invalid or expired bootstrap credential', 'bootstrap-credential-invalid')
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    )
    return operation
  }
  async test(value: string, connection?: PlatformDatabaseConnection) {
    this.authorize(value)
    if (!this.pending()) throw new BusinessRuleError('conflict', 'Platform database selection is already committed', 'database-selection-committed')
    return await this.track(this.storage.inspect(structuredClone(connection)))
  }
  private accept(value: string, choose: () => Promise<void>): Promise<void> {
    this.authorize(value)
    const operation = this.selecting.then(async () => {
      // Already accepted operations drain on close; the invitation can still expire or be consumed.
      if (!this.credential.verify(value)) throw new BusinessRuleError('forbidden', 'Invalid or expired bootstrap credential', 'bootstrap-credential-invalid')
      const pending = this.storage.pending()
      let activating = false
      try {
        await choose()
        activating = true
        await this.activate()
      } catch (error) {
        if (activating || (pending && !this.storage.pending())) this.onFailed()
        throw error
      }
    })
    this.selecting = operation.then(
      () => {},
      () => {},
    )
    return this.track(operation)
  }
  select(value: string, connection?: PlatformDatabaseConnection): Promise<void> {
    const accepted = structuredClone(connection)
    return this.accept(value, () => this.storage.select(accepted))
  }
  resume(value: string): Promise<void> {
    return this.accept(value, async () => {
      if (this.storage.pending()) await this.storage.select()
    })
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.operations)
  }
}
