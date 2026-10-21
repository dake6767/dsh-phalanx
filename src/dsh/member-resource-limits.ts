import { instanceResourceLimits, UNLIMITED_INSTANCE_RESOURCES, type InstanceResourceLimits } from '../domain/instance-resources.js'

/** Import the old positive deployment flags once; later settings replace the whole tuple. */
export function legacyInstanceResources(args: readonly string[] | undefined): InstanceResourceLimits {
  const result = { ...UNLIMITED_INSTANCE_RESOURCES }
  for (let index = 0; index < (args?.length ?? 0); index += 2) {
    const flag = args![index], value = args![index + 1]
    if (!value) throw invalid()
    if (flag === '--cpus' && /^\d+(?:\.\d+)?$/u.test(value) && Number(value) > 0) result.cpus = Number(value)
    else if (flag === '--pids-limit' && /^[1-9]\d*$/u.test(value)) result.pids = Number(value)
    else if (flag === '--memory' && /^\d+[bBkKmMgGtTpP]?$/u.test(value) && Number.parseInt(value, 10) > 0) {
      const suffix = value.match(/[a-z]$/iu)?.[0]?.toLowerCase() ?? 'b'
      const bytes = Number.parseInt(value, 10) * 1024 ** 'bkmgtp'.indexOf(suffix)
      result.memoryMiB = bytes / 1024 ** 2
    } else throw invalid()
  }
  return instanceResourceLimits(result)
}
/** Explicit unlimited values also remove Podman's default per-container PID limit. */
export function instanceResourceArguments(input: InstanceResourceLimits): string[] {
  const limits = instanceResourceLimits(input), memory = limits.memoryMiB === null ? null : limits.memoryMiB * 1024 ** 2
  return ['--cpus', String(limits.cpus ?? 0), '--memory', String(memory ?? 0), '--memory-swap', String(memory ?? -1), '--pids-limit', String(limits.pids ?? -1)]
}
function invalid() { return new Error('container extra arguments must be positive resource limits (--memory, --cpus, --pids-limit)') }
