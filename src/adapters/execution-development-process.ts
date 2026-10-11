import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionFailure, type ExecutionEvent } from '../domain/platform-execution.js'
import type { ContainerExecutionInput } from './execution-container-process.js'

/** Explicit development fallback. This runs trusted preparation/commands without filesystem isolation. */
export class DevelopmentExecutionProcess {
  async run(input: ContainerExecutionInput, emit: (event: ExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted()
    const home = await mkdtemp(join(tmpdir(), 'phalanx-execution-home-'))
    if (signal.aborted) { await rm(home, { recursive: true, force: true }); signal.throwIfAborted() }
    const translate = (value: string) => {
      const mount = [...input.mounts].sort((a, b) => b.mounted.length - a.mounted.length).find(row => value === row.mounted || value.startsWith(row.mounted + '/'))
      return mount ? mount.host + value.slice(mount.mounted.length) : value
    }
    const environment = { ...input.environment, HOME: home, TMPDIR: home, PATH: (input.environment.PATH ?? '').split(':').map(translate).join(':') + ':' + (process.env.PATH ?? '/usr/bin:/bin') }
    const timeout = AbortSignal.timeout(input.timeoutMs ?? 120_000), cancellation = AbortSignal.any([signal, timeout])
    const child = spawn(translate(input.command), input.argv.map(translate), { cwd: translate(input.cwd), env: environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } } child.stdout.destroy(); child.stderr.destroy() }
    const exited = new Promise<number>((resolve, reject) => { child.once('error', () => reject(new ExecutionFailure('development-failed'))); child.once('close', code => resolve(code ?? 125)) })
    cancellation.addEventListener('abort', kill, { once: true })
    child.stdin.on('error', () => {}); child.stdin.end(input.stdin)
    const pipe = async (stream: 'stdout' | 'stderr') => {
      for await (const data of child[stream]) {
        let cancel!: () => void
        const aborted = new Promise<never>((_, reject) => { cancel = () => reject(cancellation.reason); cancellation.addEventListener('abort', cancel, { once: true }) })
        try { cancellation.throwIfAborted(); await Promise.race([emit({ stream, data }), aborted]) }
        finally { cancellation.removeEventListener('abort', cancel) }
      }
    }
    try {
      const [code] = await Promise.all([exited, pipe('stdout'), pipe('stderr')])
      cancellation.throwIfAborted(); return code
    } catch (error) { if (timeout.aborted) throw new ExecutionFailure('timeout'); throw error }
    finally { cancellation.removeEventListener('abort', kill); kill(); await Promise.allSettled([exited]); await rm(home, { recursive: true, force: true }) }
  }
}
