import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileText } from '../src/adapters/runtime-command.js'

/** Diagnostic workload, confined to explicitly named disposable containers. */
export async function measureResourceLimits(image: string) {
  const ownership = randomUUID(), name = `performance-limits-${ownership}`
  const label = `dsh-phalanx.performance=${ownership}`
  const podman = (args: string[]) => execFileText('podman', args, { timeout: 120000 })
  const removeOwned = async () => {
    const ids = (await podman(['ps', '-a', '--filter', 'label=' + label, '--format', '{{.ID}}'])).trim().split(/\s+/u).filter(Boolean)
    for (const id of ids) await podman(['rm', '-f', id])
  }
  const values = async () => JSON.parse(await podman(['exec', name, 'node', '-e', `const fs=require('fs');console.log(JSON.stringify(Object.fromEntries(['cpu.max','memory.max','memory.swap.max','pids.max','memory.events'].map(n=>[n,fs.readFileSync('/sys/fs/cgroup/'+n,'utf8').trim()]))))`])) as Record<string, string>
  try {
    await podman(['run', '-d', '--name', name, '--label', label, '--cpus', '0.5', '--memory', '128m', '--memory-swap', '128m', '--pids-limit', '64', '--entrypoint', 'node', image, '-e', 'setInterval(()=>{},1000)'])
    const valid = (effective: Record<string, string>, cpu: number, memory: number, pids: number) => {
      const [quota, period] = effective['cpu.max']!.split(' ').map(Number)
      return quota! / period! === cpu && effective['memory.max'] === String(memory * 1024 * 1024) && effective['memory.swap.max'] === '0' && effective['pids.max'] === String(pids)
    }
    const initial = await values()
    assert(valid(initial, 0.5, 128, 64), 'Startup cgroup limits must match the requested values')
    const changes = [
      { kind: 'cpu', args: ['--cpus', '0.75'], matches: (v: Record<string, string>) => { const [quota, period] = v['cpu.max']!.split(' ').map(Number); return quota! / period! === 0.75 } },
      { kind: 'memory', args: ['--memory', '192m', '--memory-swap', '192m'], matches: (v: Record<string, string>) => v['memory.max'] === String(192 * 1024 * 1024) && v['memory.swap.max'] === '0' },
      { kind: 'pids', args: ['--pids-limit', '96'], matches: (v: Record<string, string>) => v['pids.max'] === '96' },
    ]
    const updates = []
    for (const change of changes) {
      try {
        await podman(['update', ...change.args, name])
        const effective = await values()
        updates.push({ kind: change.kind, supported: change.matches(effective), effective })
      } catch (error) { updates.push({ kind: change.kind, supported: false, error: String(error) }) }
    }
    const update = { supported: updates.every(row => row.supported), changes: updates }
    // Touch every allocated page: V8's reserved address space alone cannot prove OOM.
    let allocationExit = 'completed'
    try { await podman(['exec', name, 'node', '-e', 'const held=[];setInterval(()=>{held.push(Buffer.alloc(16*1024*1024,1))},20)']) }
    catch (error) { allocationExit = String(error) }
    const after = await values()
    const killedCount = (value: string) => Number(/^oom_kill (\d+)$/mu.exec(value)?.[1] ?? 0)
    assert(killedCount(after['memory.events']!) > killedCount(initial['memory.events']!), 'The bounded load must cause a kernel OOM kill')
    const survivor = JSON.parse(await podman(['inspect', name]))[0].State as { Running: boolean, OOMKilled: boolean, ExitCode: number }
    await removeOwned()
    // Separate whole-container PID 1 death from an exec child killed in a live DSH carrier.
    await podman(['run', '-d', '--name', name, '--label', label, '--memory', '128m', '--memory-swap', '128m', '--entrypoint', 'node', image, '-e', 'const held=[];setInterval(()=>{held.push(Buffer.alloc(16*1024*1024,1))},20)'])
    const pid1Exit = await podman(['wait', name])
    const killed = JSON.parse(await podman(['inspect', name]))[0].State as { Running: boolean, OOMKilled: boolean, ExitCode: number }
    assert.equal(killed.OOMKilled, true, 'PID 1 load must be reported as OOM killed')
    assert.equal(killed.ExitCode, 137)
    return { initial, update, childOom: { allocationExit, after, survivor }, pid1Oom: { pid1Exit: pid1Exit.trim(), state: killed } }
  } finally { await removeOwned() }
}
