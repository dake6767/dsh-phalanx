import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { PASTA_HOST_LOOPBACK_OPTION } from '../dsh/container.js'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

// Keep the helper's output on a terminal and own its lifetime as a direct
// child. util-linux script can exit after signalling its child without reaping it.
const terminalHelp = `
import errno
import os
import pty
import select
import signal
import subprocess
import sys
import time

cancelled = False

def cancel(_signum, _frame):
    global cancelled
    cancelled = True

signal.signal(signal.SIGTERM, cancel)
master, slave = pty.openpty()
helper = None
try:
    try:
        helper = subprocess.Popen(
            [sys.argv[1], "--help"],
            stdin=subprocess.DEVNULL,
            stdout=slave,
            stderr=slave,
        )
    finally:
        os.close(slave)

    terminal_open = True
    deadline = None
    while terminal_open or helper.poll() is None:
        if cancelled:
            if deadline is None:
                helper.terminate()
                deadline = time.monotonic() + 2
            elif time.monotonic() >= deadline:
                break
        readable, _, _ = select.select([master] if terminal_open else [], [], [], 0.05)
        if not readable:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b""
        if chunk:
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        else:
            terminal_open = False

    if helper.poll() is None:
        helper.kill()
    sys.exit(helper.wait())
finally:
    os.close(master)
    if helper is not None and helper.poll() is None:
        helper.kill()
        helper.wait()
`

/** Observe the same helper Podman resolves, without guessing from distribution or package versions. */
export async function readPastaLoopbackMapping(
  runtime: string,
  signal: AbortSignal,
  passthroughEnvironment: Readonly<Record<string, string>> = {},
): Promise<boolean> {
  try {
    const env = { ...containerClientEnvironment(), ...passthroughEnvironment }
    const info: { host?: { pasta?: { executable?: unknown } } } = JSON.parse(
      await execFileText(runtime, ['info', '--format', 'json'], { env, signal, timeout: 10000, maxBuffer: 256 * 1024 }),
    )
    const helper = info?.host?.pasta?.executable
    if (typeof helper !== 'string' || !isAbsolute(helper)) throw new Error('Podman did not identify its pasta helper')
    // Some pasta versions use _exit without flushing piped help. A terminal preserves its tail.
    const invocation =
      process.platform === 'linux' ? { command: '/usr/bin/python3', args: ['-I', '-c', terminalHelp, helper] } : { command: helper, args: ['--help'] }
    const help = await new Promise<string>((resolveHelp, reject) => {
      signal.throwIfAborted()
      const child = spawn(invocation.command, invocation.args, { env: { ...containerClientEnvironment(), SHELL: '/bin/sh' } })
      let failure: Error | undefined,
        stopping = false
      const stop = (error: Error) => {
        failure ??= error
        if (stopping) return
        stopping = true
        child.kill('SIGTERM')
      }
      const streams = [child.stdout, child.stderr].map(stream => {
        const chunks: Buffer[] = []
        let bytes = 0
        stream.on('data', (chunk: Buffer) => {
          // Keep draining after cancellation or a limit. Closing the pipe can
          // make the terminal exit while its helper is still alive.
          if (failure) return
          bytes += chunk.length
          if (bytes > 256 * 1024) stop(new Error('Pasta help exceeded its output limit'))
          else chunks.push(chunk)
        })
        stream.once('error', stop)
        return chunks
      })
      const abort = () => stop(new Error('Pasta help cancelled')),
        timer = setTimeout(() => stop(new Error('Pasta help timed out')), 10000)
      child.once('error', error => {
        failure ??= error
      })
      child.once('close', code => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (failure) reject(failure)
        else if (code !== 0) reject(new Error('Pasta help did not complete'))
        else resolveHelp(streams.map(chunks => Buffer.concat(chunks).toString('utf8')).join('\n'))
      })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      child.stdin?.on('error', () => {})
      child.stdin?.end()
    })
    const options = new Set(help.split(/[\s,\p{Cc}]+/u))
    if (!options.has('--tcp-ports')) throw new Error('Pasta did not report its supported options')
    return options.has(PASTA_HOST_LOOPBACK_OPTION)
  } catch (cause) {
    signal.throwIfAborted()
    throw new CommunityRuntimeUnavailableError('startup-unavailable', 'Container loopback forwarding capability could not be determined', { cause })
  }
}
