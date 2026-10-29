/**
 * The shared lifetime of a PostgreSQL-backed store: one initialization, serialized
 * writes, and a close that waits for accepted writes before releasing state. Each
 * store names itself so its errors stay specific; the queue and drain live here.
 */
export class PlatformStoreLifecycle {
  private initialization: Promise<void> | undefined
  private writing: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined
  private closed = false
  constructor(private readonly name: string) {}

  /** Runs `load` once; later calls share its promise. Refused after close begins. */
  initialize(load: () => Promise<void>): Promise<void> {
    if (this.closing || this.closed) return Promise.reject(Error(`${this.name} is closed`))
    return (this.initialization ??= load())
  }

  /** Queues `operation` after every accepted write; a failed write does not block the next one. */
  write<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing || this.closed) return Promise.reject(Error(`${this.name} is closed`))
    const result = this.writing.then(operation)
    this.writing = result.then(
      () => {},
      () => {},
    )
    return result
  }

  /** Waits for initialization and accepted writes, then runs `release` once. */
  close(release: () => void = () => {}): Promise<void> {
    return (this.closing ??= Promise.allSettled([this.initialization, this.writing]).then(() => {
      release()
      this.closed = true
    }))
  }

  /** For synchronous reads: closed is an error; not-yet-loaded is reported by the caller's own state. */
  assertOpen(): void {
    if (this.closed) throw Error(`${this.name} is closed`)
  }

  /** For new writes: closing already refuses them. */
  assertAccepting(): void {
    if (this.closing || this.closed) throw Error(`${this.name} is closed`)
  }
}
