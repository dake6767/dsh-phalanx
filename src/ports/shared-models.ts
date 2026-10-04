import type { SharedModelState } from '../domain/shared-models.js'

/** Protected platform configuration, with atomic revision-checked publication. */
export interface SharedModelStorePort {
  read(): SharedModelState
  save(state: SharedModelState): void
  newId(): string
}
