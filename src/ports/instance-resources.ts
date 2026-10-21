import type { InstanceResourceHost, InstanceResourceLimits, InstanceResourceState } from '../domain/instance-resources.js'

export interface InstanceResourceStorePort {
  read(): InstanceResourceState
  save(state: InstanceResourceState): void
}
export interface InstanceResourceHostPort { read(): InstanceResourceHost }
/** The driver asks only after resolving the stable user-space identity. */
export interface MemberInstanceResourcePort { forSpace(spaceId: string): InstanceResourceLimits }
