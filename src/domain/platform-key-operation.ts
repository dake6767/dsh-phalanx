import type { PlatformSecretRegistry } from './platform-secret.js'

export interface RotationSource {
  readonly configFile: string
  readonly oldRegistry: PlatformSecretRegistry
  readonly registry: PlatformSecretRegistry
  readonly platform: boolean
}
/** Protected durable operator intent; it contains wrapped keys, never a plaintext credential. */
interface RotationPlan {
  readonly version: 1
  readonly kind: 'rotate' | 'reset'
  readonly deploymentId: string
  readonly configFile: string
  readonly dataRoot: string
  readonly maintenanceFile: string
  readonly marker: string
  readonly managedOperation?: string
  readonly master: { readonly path: string; readonly staged: string }
  readonly configurations: readonly { readonly path: string; readonly staged: string; readonly registry: PlatformSecretRegistry }[]
}
export type RotationJournal = RotationPlan &
  (
    | { readonly phase: 'preparing'; readonly sources: readonly Omit<RotationSource, 'registry'>[] }
    | { readonly phase: 'prepared'; readonly sources: readonly RotationSource[] }
  )
