/**
 * One atomic change across several repositories. The use case owns the boundary:
 * everything `operation` writes through the repositories it receives commits
 * together or not at all. External I/O (downloads, artifact preparation, container
 * work) belongs before `run`; `operation` only records results that are ready.
 *
 * `Repositories` is the set of domain repositories one transaction exposes. Each
 * repository is bound to that transaction and must not be kept after `run` returns.
 */
export interface PlatformUnitOfWorkPort<Repositories> {
  /** `committed` performs synchronous in-memory lifecycle cleanup after SQL COMMIT,
   * even if subsequent view publication fails; it must not start external I/O. */
  run<T>(operation: (repositories: Repositories) => Promise<T>, committed?: (value: T) => void): Promise<T>
}
