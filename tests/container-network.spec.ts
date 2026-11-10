import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { readPastaLoopbackMapping } from '../src/adapters/container-network.js'

async function withRuntimeHelper(action: (runtime: string, helper: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pasta-capability-'))
  const runtime = join(root, 'podman'),
    helper = join(root, "pasta helper's CLI")
  try {
    await writeFile(runtime, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ host: { pasta: { executable: helper } } }))})`, {
      mode: 0o700,
    })
    await action(runtime, helper)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it.each(['stdout', 'stderr'] as const)('detects explicit loopback mapping from the runtime-selected helper help on %s', async stream => {
  await withRuntimeHelper(async (runtime, helper) => {
    await writeFile(
      helper,
      `#!/usr/bin/env node\nif(process.argv[2]!=='--help')process.exit(2);process.${stream}.write('Usage: pasta\\n  --tcp-ports SPEC\\n  --host-lo-to-ns-lo\\n')`,
      { mode: 0o700 },
    )
    expect(await readPastaLoopbackMapping(runtime, new AbortController().signal)).toBe(true)
  })
})

it.runIf(process.platform === 'linux')('reads the complete capability help when a helper only flushes its tail to a terminal', async () => {
  await withRuntimeHelper(async (runtime, helper) => {
    await writeFile(
      helper,
      `#!/usr/bin/env node\nprocess.stdout.write('Usage: pasta\\n--tcp-ports SPEC\\n');if(process.stdout.isTTY)process.stdout.write('--host-lo-to-ns-lo\\n')`,
      { mode: 0o700 },
    )
    expect(await readPastaLoopbackMapping(runtime, new AbortController().signal)).toBe(true)
  })
})

it('keeps the old mapping for older help and does not mistake a longer option for support', async () => {
  await withRuntimeHelper(async (runtime, helper) => {
    for (const help of ['--tcp-ports SPEC', '--tcp-ports SPEC\n--host-lo-to-ns-lo-extra']) {
      await writeFile(helper, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(help)})`, { mode: 0o700 })
      expect(await readPastaLoopbackMapping(runtime, new AbortController().signal)).toBe(false)
    }
  })
})

it('refuses unknown capabilities when the helper is missing, fails or returns empty help', async () => {
  await withRuntimeHelper(async (runtime, helper) => {
    const read = () => readPastaLoopbackMapping(runtime, new AbortController().signal)
    await expect(read()).rejects.toThrow('capability could not be determined')
    await writeFile(helper, '#!/usr/bin/env node\nprocess.exit(2)', { mode: 0o700 })
    await expect(read()).rejects.toThrow('capability could not be determined')
    await writeFile(helper, '#!/usr/bin/env node\n', { mode: 0o700 })
    await expect(read()).rejects.toThrow('capability could not be determined')
    await writeFile(runtime, '#!/usr/bin/env node\nprocess.stdout.write("{}")')
    await expect(read()).rejects.toThrow('capability could not be determined')
  })
})

it('preserves startup cancellation instead of reporting unsupported pasta', async () => {
  await withRuntimeHelper(async runtime => {
    const controller = new AbortController()
    controller.abort(new Error('fixture startup cancelled'))
    await expect(readPastaLoopbackMapping(runtime, controller.signal)).rejects.toThrow('fixture startup cancelled')
  })
})

it.each(['stdout', 'stderr'] as const)('refuses capability help beyond the byte limit on %s', async stream => {
  await withRuntimeHelper(async (runtime, helper) => {
    await writeFile(helper, `#!/usr/bin/env node\nprocess.${stream}.write('--tcp-ports SPEC --host-lo-to-ns-lo '+ '界'.repeat(100000))`, { mode: 0o700 })
    await expect(readPastaLoopbackMapping(runtime, new AbortController().signal)).rejects.toThrow('capability could not be determined')
  })
})

it('waits for the cancelled help process to exit before completing the observation', async () => {
  await withRuntimeHelper(async (runtime, helper) => {
    const ready = join(dirname(helper), 'ready'),
      terminated = join(dirname(helper), 'terminated'),
      release = join(dirname(helper), 'release'),
      identity = join(dirname(helper), 'identity'),
      signals = join(dirname(helper), 'signals'),
      controller = new AbortController()
    type Identity = { pid: number; ppid: number; started: string | null; parentStarted: string | null }
    type ProcessFact = { pid: number; exited: boolean; identity: string; state?: string }
    let helperIdentity: Identity | undefined, completionFacts: ProcessFact[] | undefined, inspectionError: string | undefined
    const inspect = (pid: number, started: string): ProcessFact => {
      let stat: string
      try {
        stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return { pid, exited: true, identity: 'exited' }
        throw error
      }
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/u)
      const state = fields[0],
        currentStart = fields[19]
      if (state === undefined || currentStart === undefined || !/^\d+$/u.test(currentStart) || !/^[RSDZTWtXxKPI]$/u.test(state))
        throw new Error('Unrecognized process identity')
      if (currentStart !== started) return { pid, exited: true, identity: 'reused' }
      return { pid, exited: ['Z', 'X', 'x'].includes(state), identity: 'fixture', state }
    }
    const inspectBoth = () => {
      if (!helperIdentity?.started || !helperIdentity.parentStarted) throw new Error('Initial helper process identities are unavailable')
      return [inspect(helperIdentity.pid, helperIdentity.started), inspect(helperIdentity.ppid, helperIdentity.parentStarted)]
    }
    const expectCompletedProcessesExited = () => {
      if (inspectionError || completionFacts?.some(row => !row.exited)) {
        let observedSignals: string | null = null
        try {
          observedSignals = readFileSync(signals, 'utf8').slice(-1000)
        } catch {
          /* Preserve the completion-time identity evidence. */
        }
        console.error('Cancelled helper completion facts:', JSON.stringify({ completionFacts, inspectionError, signals: observedSignals }))
      }
      expect(inspectionError).toBeUndefined()
      expect(completionFacts).toHaveLength(2)
      expect(
        completionFacts!.every(row => row.exited),
        JSON.stringify(completionFacts),
      ).toBe(true)
    }
    await writeFile(
      helper,
      `#!/usr/bin/env node
const fs=require('node:fs');const release=${JSON.stringify(release)};
fs.watch(${JSON.stringify(dirname(helper))},()=>{if(fs.existsSync(release))process.exit(0)});
// Keep cooperative shutdown under fixture control; forced exits are verified by process identity.
process.on('SIGHUP',()=>fs.appendFileSync(${JSON.stringify(signals)},'SIGHUP\\n'));
process.stdout.on('error',error=>fs.appendFileSync(${JSON.stringify(signals)},'output:'+error.code+'\\n'));
process.on('SIGTERM',()=>{fs.appendFileSync(${JSON.stringify(signals)},'SIGTERM\\n');fs.writeFileSync(${JSON.stringify(terminated)},'terminated');process.stdout.write('x'.repeat(1024*1024))});
const start=pid=>{try{const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');return stat.slice(stat.lastIndexOf(')')+2).trim().split(/\\s+/)[19]}catch{return null}};
const parentOwned=()=>{try{return fs.readFileSync('/proc/'+process.ppid+'/cmdline','utf8').includes(${JSON.stringify(dirname(helper) + '/')})}catch{return false}};
fs.writeFileSync(${JSON.stringify(identity)},JSON.stringify({pid:process.pid,ppid:process.ppid,started:start(process.pid),parentStarted:parentOwned()?start(process.ppid):null,node:process.version,arch:process.arch}));
fs.writeFileSync(${JSON.stringify(ready)},'ready');if(fs.existsSync(release))process.exit(0);
`,
      { mode: 0o700 },
    )
    let settled = false
    const outcome = readPastaLoopbackMapping(runtime, controller.signal)
      .then(
        value => ({ value }),
        error => ({ error }),
      )
      .finally(() => {
        settled = true
        if (process.platform === 'linux') {
          try {
            // Sample synchronously at completion, never after waiting for a later exit.
            completionFacts = inspectBoth()
          } catch (error) {
            inspectionError = String(error)
          }
        }
      })
    const failures: unknown[] = []
    try {
      await expect.poll(() => readFile(ready, 'utf8').catch(() => ''), { timeout: 10000 }).toBe('ready')
      helperIdentity = JSON.parse(await readFile(identity, 'utf8')) as Identity
      if (process.platform === 'linux') {
        expect(helperIdentity.started).toMatch(/^\d+$/u)
        expect(helperIdentity.parentStarted).toMatch(/^\d+$/u)
      }
      controller.abort(new Error('fixture help cancelled'))
      await expect.poll(() => readFile(terminated, 'utf8').catch(() => ''), { timeout: 10000 }).toBe('terminated')
      const completedBeforeRelease = settled
      // A terminal can end the helper itself. Early completion is valid only
      // with proof that both original processes had already exited.
      if (settled && process.platform === 'linux') expectCompletedProcessesExited()
      else expect(settled).toBe(false)
      await writeFile(release, 'release')
      expect(await outcome).toEqual({ error: controller.signal.reason })
      if (process.platform === 'linux') {
        expectCompletedProcessesExited()
        console.info('Cancelled helper exit proof:', JSON.stringify({ completedBeforeRelease, completionFacts }))
      }
    } catch (error) {
      failures.push(error)
    } finally {
      try {
        await writeFile(release, 'release')
        controller.abort()
        await outcome
        if (process.platform === 'linux' && helperIdentity?.started && helperIdentity.parentStarted)
          await expect.poll(() => inspectBoth().every(row => row.exited), { timeout: 10000 }).toBe(true)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Cancellation assertion and owned process cleanup failed')
  })
})

it('resolves the helper with the launch client environment without giving member values to helper help', async () => {
  await withRuntimeHelper(async (runtime, helper) => {
    await writeFile(runtime, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({host:{pasta:{executable:process.env.FIXTURE_PASTA_HELPER}}}))')
    await writeFile(
      helper,
      '#!/usr/bin/env node\nif(process.env.FIXTURE_PASTA_HELPER)process.exit(2);process.stdout.write("--tcp-ports SPEC --host-lo-to-ns-lo")',
      { mode: 0o700 },
    )
    expect(await readPastaLoopbackMapping(runtime, new AbortController().signal, { FIXTURE_PASTA_HELPER: helper })).toBe(true)
  })
})
