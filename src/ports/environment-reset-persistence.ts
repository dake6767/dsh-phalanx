import type { EnvironmentResetHistoryPort } from './environment-reset-history.js'
import type { PlatformUnitOfWorkPort } from './platform-unit-of-work.js'
import type { SpaceResetActors } from './space-actors.js'

export interface EnvironmentResetRepositories {
  readonly actors: SpaceResetActors
  readonly history: EnvironmentResetHistoryPort
}
export interface EnvironmentResetPersistence {
  readonly history: EnvironmentResetHistoryPort
  readonly work: PlatformUnitOfWorkPort<EnvironmentResetRepositories>
}
