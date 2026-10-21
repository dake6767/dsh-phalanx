import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cpus, totalmem } from 'node:os'
import type { InstanceResourceEffective } from '../domain/instance-resources.js'
import type { InstanceResourceHostPort } from '../ports/instance-resources.js'

export class NodeInstanceResourceHost implements InstanceResourceHostPort {
  read() { return { memoryBytes: totalmem(), cpuCount: cpus().length } }
}
/** Reads the kernel values of a validated, currently owned carrier PID. */
export class CgroupInstanceResources {
  constructor(private readonly paths = { proc: '/proc', cgroup: '/sys/fs/cgroup' }) {}
  async read(pid: number): Promise<InstanceResourceEffective> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid member process identity')
    const rows = await readFile(join(this.paths.proc, String(pid), 'cgroup'), 'utf8')
    const path = rows.split('\n').find(line => line.startsWith('0::'))?.slice(3)
    if (!path?.startsWith('/') || path.split('/').includes('..')) throw new Error('Unified member cgroup is unavailable')
    const [cpu, memory, swap, pids] = await Promise.all(['cpu.max', 'memory.max', 'memory.swap.max', 'pids.max'].map(name => readFile(join(this.paths.cgroup, path, name), 'utf8').then(value => value.trim())))
    const [quota, period] = cpu!.split(/\s+/u)
    const cpuPeriod = bounded(period!)
    if (cpuPeriod === null || cpuPeriod <= 0) throw new Error('Invalid member CPU period')
    const cpuQuota = bounded(quota!), memoryBytes = bounded(memory!), swapBytes = bounded(swap!)
    return { limits: { cpus: cpuQuota === null ? null : cpuQuota / cpuPeriod, memoryMiB: memoryBytes === null ? null : memoryBytes / 1024 ** 2, pids: bounded(pids!) }, swapMiB: swapBytes === null ? null : swapBytes / 1024 ** 2 }
  }
}
function bounded(value: string): number | null {
  if (value === 'max') return null
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid member cgroup limit')
  return Number(value)
}
