import type { SharedModelState } from '../domain/shared-models.js'

/** Protected platform configuration, with atomic revision-checked persistence and recoverable runtime publication. */
export interface SharedModelStorePort {
  read(): SharedModelState
  save(state: SharedModelState): Promise<void>
  newId(): string
}

/** A staged runtime projection is inactive until publication; only its owner removes it. */
export interface PreparedSharedModels {
  publish(): void
  discard(): void
}
export interface SharedModelProjectionPort {
  prepare(state: SharedModelState): PreparedSharedModels
}

/** Per-space derived model projections; the entering browser language selects the placeholder language. */
export interface MemberModelsProjectionPort {
  enter(spaceId: string, locale: import('../domain/platform-language.js').PlatformLocale): void
  ensure(spaceId: string): void
  mount(spaceId: string): { patch: string; volumes: readonly { host: string; mounted: string }[] }
  publish(state: SharedModelState): void
}
