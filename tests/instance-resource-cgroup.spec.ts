import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CgroupInstanceResources } from '../src/adapters/instance-resource-cgroup.js'

it('reads actual unified cgroup limits, including disabled swap and unlimited values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'member-cgroup-')), proc = join(root, 'proc'), cgroup = join(root, 'cgroup'), target = join(cgroup, 'owned')
  try {
    await mkdir(join(proc, '123'), { recursive: true }); await mkdir(target, { recursive: true })
    await writeFile(join(proc, '123', 'cgroup'), '0::/owned\n')
    const write = async (values: Record<string, string>) => { for (const [name, value] of Object.entries(values)) await writeFile(join(target, name), value) }
    await write({ 'cpu.max': '50000 100000', 'memory.max': '134217728', 'memory.swap.max': '0', 'pids.max': '64' })
    const reader = new CgroupInstanceResources({ proc, cgroup })
    expect(await reader.read(123)).toEqual({ limits: { cpus: 0.5, memoryMiB: 128, pids: 64 }, swapMiB: 0 })
    await write({ 'cpu.max': 'max 100000', 'memory.max': 'max', 'memory.swap.max': 'max', 'pids.max': 'max' })
    expect(await reader.read(123)).toEqual({ limits: { cpus: null, memoryMiB: null, pids: null }, swapMiB: null })
    await writeFile(join(proc, '123', 'cgroup'), '0::/../../outside\n')
    await expect(reader.read(123)).rejects.toThrow()
    await expect(reader.read(456)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
