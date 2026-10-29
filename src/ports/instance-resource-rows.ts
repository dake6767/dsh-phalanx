import type { InstanceResourceLimits, InstanceResourceState } from '../domain/instance-resources.js'

/** One shared revision protects settings and each independent space update. */
export interface InstanceResourceRows {
  read(): Promise<InstanceResourceState>
  saveDefaults(expectedRevision: number, limits: InstanceResourceLimits, idleSeconds: number): Promise<void>
  saveMember(expectedRevision: number, spaceId: string, override: InstanceResourceLimits | null, resident?: boolean): Promise<void>
}
