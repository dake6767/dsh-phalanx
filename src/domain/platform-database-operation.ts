/** A protected, bounded local journal contains encrypted configurations, never a plaintext password. */
export interface DatabaseSwitchJournal {
  readonly version: 1
  readonly kind: 'database-switch'
  readonly id: string
  readonly phase: 'preparing' | 'copying' | 'committing' | 'committed' | 'rolled-back'
  readonly deploymentId: string
  readonly configFile: string
  readonly dataRoot: string
  readonly maintenanceFile: string
  readonly marker: string
  readonly managedOperation?: string
  readonly original: string
  readonly originalHash: string
  readonly nextHash?: string
  readonly archive: string
  readonly staging: string
}
