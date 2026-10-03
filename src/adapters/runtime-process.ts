import type { ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ContainerConfig } from '../domain/community-config.js'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'
import { parsePublishedPort } from '../dsh/container.js'
import { DSH_READY_PATTERN } from '../dsh/readiness.js'
import { execFileText, sanitize } from './runtime-command.js'

const MAX_DIAGNOSTIC_BYTES = 64 * 1024
const PUBLISHED_PORT_ATTEMPTS = 5
const PUBLISHED_PORT_RETRY_MS = 200

export function waitForReady(child: ChildProcess, timeoutMs: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolveReady, reject) => {
    let output = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error(`DSH did not become ready within ${String(timeoutMs)} ms: ${sanitize(output)}`)), timeoutMs)
    const onData = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-MAX_DIAGNOSTIC_BYTES)
      const match = DSH_READY_PATTERN.exec(output)
      if (match?.[1] !== undefined) finish(undefined, match[1])
    }
    const onError = (error: Error): void => { finish(error) }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`DSH exited before ready (code ${String(code)}, signal ${String(signal)}): ${sanitize(output)}`))
    }
    const onAbort = (): void => {
      finish(new CommunityRuntimeUnavailableError('start-cancelled', 'DSH startup cancelled'))
    }
    const finish = (error?: Error, readyUrl?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      signal.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else if (readyUrl !== undefined) resolveReady(readyUrl)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

export async function terminateChild(
  child: ChildProcess,
  exited: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await exited
    return
  }
  child.kill('SIGTERM')
  let timer: NodeJS.Timeout | undefined
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>(resolveTimeout => {
      timer = setTimeout(() => { resolveTimeout(false) }, timeoutMs)
      timer.unref()
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)
  if (graceful) return
  child.kill('SIGKILL')
  await exited
}

export async function resolvePublishedPort(container: ContainerConfig, containerName: string): Promise<number> {
  let lastError: unknown
  for (let attempt = 0; attempt < PUBLISHED_PORT_ATTEMPTS; attempt += 1) {
    try {
      const output = await execFileText(container.runtime, ['port', containerName, `${String(container.internalPort)}/tcp`])
      return parsePublishedPort(output)
    } catch (error) {
      lastError = error
      await sleep(PUBLISHED_PORT_RETRY_MS)
    }
  }
  throw new Error(`container runtime did not report the instance's published port: ${lastError instanceof Error ? lastError.message : 'unknown error'}`)
}

export function rewriteToHostPort(url: URL, hostPort: number): URL {
  const rewritten = new URL(url.href)
  rewritten.hostname = '127.0.0.1'
  rewritten.port = String(hostPort)
  return rewritten
}
