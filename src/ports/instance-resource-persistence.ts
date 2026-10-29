import type { InstanceResourceRows } from './instance-resource-rows.js'
import type { PlatformUnitOfWorkPort } from './platform-unit-of-work.js'
import type { SpaceAdministrators } from './space-actors.js'

export interface InstanceResourceRepositories {
  readonly actors: SpaceAdministrators
  readonly settings: InstanceResourceRows
}
export interface InstanceResourcePersistence {
  readonly rows: InstanceResourceRows
  readonly work: PlatformUnitOfWorkPort<InstanceResourceRepositories>
}
