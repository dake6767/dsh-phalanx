/** Serialize asynchronous operations by local owner without coupling independent owners. */
export class KeyedOperations {
  private readonly pending = new Map<string, Promise<unknown>>()
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(operation)
    this.pending.set(key, result)
    const finished = () => {
      if (this.pending.get(key) === result) this.pending.delete(key)
    }
    void result.then(finished, finished)
    return result
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending.values()])
  }
}
