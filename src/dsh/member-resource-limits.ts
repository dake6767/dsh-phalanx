import { instanceResourceLimits, type InstanceResourceLimits } from '../domain/instance-resources.js'

/** Explicit unlimited values also remove Podman's default per-container PID limit. */
export function instanceResourceArguments(input: InstanceResourceLimits): string[] {
  const limits = instanceResourceLimits(input),
    memory = limits.memoryMiB === null ? null : limits.memoryMiB * 1024 ** 2
  return ['--cpus', String(limits.cpus ?? 0), '--memory', String(memory ?? 0), '--memory-swap', String(memory ?? -1), '--pids-limit', String(limits.pids ?? -1)]
}
