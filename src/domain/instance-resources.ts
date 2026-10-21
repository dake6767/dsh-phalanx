import { BusinessRuleError } from './business-error.js'

/** Null means no container limit; an override replaces all three values. */
export interface InstanceResourceLimits { readonly cpus: number | null, readonly memoryMiB: number | null, readonly pids: number | null }
export interface InstanceResourceMember {
  readonly isolated: boolean
  readonly defaults: InstanceResourceLimits
  readonly revision: number
  readonly username: string
  readonly spaceId: string
  readonly source: 'default' | 'custom'
  readonly override: InstanceResourceLimits | null
  readonly target: InstanceResourceLimits
  readonly current: InstanceResourceLimits | null
  readonly instanceKey: string | null
  readonly resident: boolean
  readonly automaticStartFailure?: { readonly at: number } | undefined
  readonly pending: boolean
}
export interface InstanceResourceSettingsView {
  readonly idleSeconds: number
  readonly revision: number
  readonly defaults: InstanceResourceLimits
  readonly suggested: InstanceResourceLimits
  readonly isolated: boolean
  readonly host: { readonly memoryMiB: number, readonly cpus: number }
  readonly capacity: { readonly runningMemoryMiB: number, readonly residentMemoryMiB: number, readonly runningUnlimited: number, readonly residentUnlimited: number, readonly totalMemoryMiB: number, readonly totalUnlimited: number, readonly overcommitted: boolean }
  readonly pending: readonly InstanceResourceMember[]
}
export interface InstanceResourceTarget { readonly username: string, readonly spaceId: string, readonly instanceKey: string }
export interface InstanceResourceApplication {
  readonly results: readonly { readonly username: string, readonly status: 'applied' | 'changed' | 'failed', readonly method?: 'updated' | 'restarted', readonly code?: 'instance-resource-apply-failed' }[]
}
export interface InstanceResourceState {
  readonly idleSeconds: number
  readonly residents: Readonly<Record<string, true>>
  readonly revision: number
  readonly defaults: InstanceResourceLimits
  readonly overrides: Readonly<Record<string, InstanceResourceLimits>>
}
export interface InstanceResourceHost { readonly memoryBytes: number, readonly cpuCount: number }
export interface InstanceResourceEffective { readonly limits: InstanceResourceLimits, readonly swapMiB: number | null }
export const UNLIMITED_INSTANCE_RESOURCES: InstanceResourceLimits = Object.freeze({ cpus: null, memoryMiB: null, pids: null })

export function instanceResourceLimits(input: unknown): InstanceResourceLimits {
  const value = input as InstanceResourceLimits | undefined
  if (!value || typeof value !== 'object') throw invalid()
  for (const key of ['cpus', 'memoryMiB', 'pids'] as const) {
    const number = value[key]
    if (number === null) continue
    if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0
      || (key === 'cpus' && (number * 100000 < 1 || !Number.isSafeInteger(Math.trunc(number * 100000))))
      || (key === 'pids' && !Number.isSafeInteger(number))
      || (key === 'memoryMiB' && !Number.isSafeInteger(number * 1024 ** 2))) throw invalid()
  }
  return { cpus: value.cpus, memoryMiB: value.memoryMiB, pids: value.pids }
}
export function effectiveInstanceResources(defaults: InstanceResourceLimits, override: InstanceResourceLimits | undefined): InstanceResourceLimits {
  return instanceResourceLimits(override ?? defaults)
}
export function suggestedInstanceResources(host: InstanceResourceHost): InstanceResourceLimits {
  return { memoryMiB: Math.max(1, Math.min(4096, Math.floor(host.memoryBytes / 2 / 1024 ** 2))), cpus: Math.max(1, host.cpuCount / 2), pids: 2048 }
}
export function sameInstanceResources(left: InstanceResourceLimits, right: InstanceResourceLimits): boolean {
  // Podman's default CPU period rounds fractional quotas to microseconds.
  const cpus = left.cpus === right.cpus || left.cpus !== null && right.cpus !== null && Math.abs(left.cpus - right.cpus) < 1 / 100000
  return cpus && left.memoryMiB === right.memoryMiB && left.pids === right.pids
}
export function instanceResourcesApplied(current: InstanceResourceEffective, target: InstanceResourceLimits): boolean {
  return sameInstanceResources(current.limits, target) && current.swapMiB === (target.memoryMiB === null ? null : 0)
}
export function memoryLimitReduced(current: number | null, target: number | null): boolean {
  return target !== null && (current === null || target < current)
}
function invalid() { return new BusinessRuleError('invalid', 'Enter positive resource limits or choose unlimited.', 'instance-resource-invalid') }

export function instanceIdleSeconds(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) throw new BusinessRuleError('invalid', 'Enter a non-negative whole number of idle seconds.', 'instance-idle-invalid')
  return input
}
