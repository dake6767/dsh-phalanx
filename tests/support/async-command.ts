import { spawn } from 'node:child_process'
import { registerValidationProcessGroup } from './validation-process-group.js'

export interface AsyncCommandResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

const DEFAULT_TIMEOUT_MS = 13_000
const KILL_GRACE_MS = 500
const activeProcessGroups = new Set<number>()
let exitCleanupRegistered = false

function killProcessGroup(pid: number): void {
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL')
    else process.kill(pid, 'SIGKILL')
  } catch {
    // Process group already exited.
  }
}

function ensureExitCleanup(): void {
  if (exitCleanupRegistered) return
  exitCleanupRegistered = true
  process.once('exit', () => {
    for (const pid of activeProcessGroups) killProcessGroup(pid)
    activeProcessGroups.clear()
  })
}

/** Run a child process asynchronously with closed stdin, registered process group, and guaranteed timeout cleanup. */
export async function runAsyncCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly timeout?: number } = {},
): Promise<AsyncCommandResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`Invalid async command timeout: ${String(timeout)}`)
  }
  ensureExitCleanup()
  return await new Promise(resolve => {
    const detached = process.platform !== 'win32'
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const pid = child.pid
    if (detached && pid !== undefined) {
      activeProcessGroups.add(pid)
      registerValidationProcessGroup(pid)
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    let timedOut = false
    let forceFinishTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: AsyncCommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceFinishTimer !== undefined) clearTimeout(forceFinishTimer)
      if (pid !== undefined) activeProcessGroups.delete(pid)
      resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (pid !== undefined) killProcessGroup(pid)
      else child.kill('SIGKILL')
      child.stdout.destroy()
      child.stderr.destroy()
      forceFinishTimer = setTimeout(() => {
        finish({
          status: null,
          signal: 'SIGKILL',
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          error: `Command timed out after ${timeout}ms`,
        })
      }, KILL_GRACE_MS)
      forceFinishTimer.unref()
    }, timeout)
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.once('error', error => {
      finish({
        status: null,
        signal: null,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        error: error.message,
      })
    })
    child.once('close', (code, signal) => {
      finish({
        status: code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ...(timedOut ? { error: `Command timed out after ${timeout}ms` } : {}),
      })
    })
  })
}
