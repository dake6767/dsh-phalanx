import { PlatformDatabaseError } from '../domain/platform-database.js'
import type { PlatformDatabase } from './platform-database.js'

/** A registered synchronous view is unavailable between invalidation and a current committed publication. */
export class PostgresCommittedView<Snapshot> {
  private value: Snapshot | undefined
  private loaded = false
  private published: string | undefined
  private loading: Promise<void> | undefined
  private unsubscribe: (() => void) | undefined
  private closed = false
  constructor(
    private readonly database: Pick<PlatformDatabase, 'writeRevision' | 'subscribeCommittedWrites'>,
    private readonly tables: readonly string[],
    private readonly load: () => Promise<Snapshot>,
  ) {}
  async initialize(): Promise<void> {
    if (this.closed) throw this.unavailable()
    this.unsubscribe ??= this.database.subscribeCommittedWrites(this.tables, () => {
      this.published = undefined
      return this.ready()
    })
    await this.ready()
  }
  ready(): Promise<void> {
    if (this.closed) return Promise.reject(this.unavailable())
    if (this.loaded && this.published === this.database.writeRevision(this.tables)) return Promise.resolve()
    if (this.loading) return this.loading.then(() => this.ready())
    const pending = this.refresh().finally(() => {
      if (this.loading === pending) this.loading = undefined
    })
    this.loading = pending
    return pending
  }
  read<Value>(project: (snapshot: Readonly<Snapshot>) => Value): Value {
    if (this.closed || !this.loaded || this.published !== this.database.writeRevision(this.tables)) throw this.unavailable()
    return structuredClone(project(this.value!))
  }
  async close(): Promise<void> {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    await this.loading?.catch(() => {})
    this.value = undefined
    this.loaded = false
    this.published = undefined
  }
  private async refresh(): Promise<void> {
    for (;;) {
      if (this.closed) throw this.unavailable()
      const generation = this.database.writeRevision(this.tables),
        snapshot = await this.load()
      if (this.closed) throw this.unavailable()
      if (generation !== this.database.writeRevision(this.tables)) continue
      this.value = snapshot
      this.loaded = true
      this.published = generation
      return
    }
  }
  private unavailable() {
    return new PlatformDatabaseError('unavailable', 'Committed platform view is not ready; retry synchronization')
  }
}
