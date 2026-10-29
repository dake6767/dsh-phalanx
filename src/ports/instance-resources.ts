import type { InstanceResourceHost, InstanceResourceLimits } from '../domain/instance-resources.js'
export interface InstanceResourceHostPort {
  read(): InstanceResourceHost
}
/** The driver asks only after resolving the stable user-space identity. */
export interface MemberInstanceResourcePort {
  forSpace(spaceId: string): Promise<InstanceResourceLimits>
}
