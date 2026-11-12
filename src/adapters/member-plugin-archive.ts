import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { MEMBER_PLUGIN_ARCHIVE_DIRECTORY, nativeArchiveVerification, nativeArchiveResolution } from '../dsh/native-plugin-replacement.js'
import { memberPluginArchiveWorker } from './member-plugin-archive-worker.js'
import type { ContainerConfig } from '../domain/community-config.js'
import { PLUGIN_UPLOAD_MAX_BYTES } from '../domain/plugin-library.js'
import { containerClientEnvironment } from './runtime-command.js'

/** Inventory reports the current dependency source, independently of installation history. */
export function retainedMemberPluginArchiveIntegrity(source: unknown): string | undefined {
  const prefix = 'file:' + MEMBER_PLUGIN_ARCHIVE_DIRECTORY + '/'
  if (typeof source !== 'string' || !source.startsWith(prefix)) return undefined
  const match = /^([a-f0-9]{128})\.tgz$/u.exec(source.slice(prefix.length))
  return match ? 'sha512-' + Buffer.from(match[1]!, 'hex').toString('base64') : undefined
}

export async function verifyMemberPluginArchive(
  container: ContainerConfig,
  name: string,
  packageName: string,
  integrity: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)) return false
  const path = join(MEMBER_PLUGIN_ARCHIVE_DIRECTORY, Buffer.from(integrity.slice(7), 'base64').toString('hex') + '.tgz')
  const verify = `const {createHash}=require('node:crypto'), {constants}=require('node:fs'), {open}=require('node:fs/promises'), {join,resolve}=require('node:path');
${nativeArchiveVerification}
${nativeArchiveResolution}
const deadline=setTimeout(()=>process.exit(1),8500);
resolvedArchive(process.argv[1],process.argv[2],process.argv[3]).then(ok=>{process.exitCode=ok?0:1},()=>{process.exitCode=1}).finally(()=>clearTimeout(deadline));`
  return await new Promise(resolve => {
    execFile(
      container.runtime,
      ['exec', name, 'node', '-e', verify, packageName, path, integrity],
      { env: containerClientEnvironment(), signal, timeout: 10000, maxBuffer: 4096 },
      error => resolve(!error),
    )
  })
}

/** Keep a checked local tarball: an expiring URL must never become a profile dependency. */
export async function receiveMemberPluginArchive(
  container: ContainerConfig,
  name: string,
  url: string,
  integrity: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted()
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)) throw new Error('Invalid archive integrity')
  const directory = MEMBER_PLUGIN_ARCHIVE_DIRECTORY
  const child = spawn(
    container.runtime,
    ['exec', '-i', name, 'node', '-e', memberPluginArchiveWorker, url, integrity, String(PLUGIN_UPLOAD_MAX_BYTES), directory],
    { env: containerClientEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let output = ''
  let timedOut = false
  // Keep the exec transport alive until its worker acknowledges cancellation by exiting.
  // Killing only the podman client leaves an active process inside the container.
  const cancel = () => {
    child.stdin.end('cancel\n')
  }
  child.stdin.on('error', () => {})
  child.stdout.on('data', (chunk: Buffer) => {
    if (output.length + chunk.length > 4096) cancel()
    else output += chunk.toString('utf8')
  })
  child.stderr.resume()
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const deadline = setTimeout(() => {
    timedOut = true
    cancel()
  }, 35000)
  const transportDeadline = setTimeout(() => child.kill('SIGKILL'), 45000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    signal.throwIfAborted()
    if (timedOut || code !== 0) throw new Error('Member archive download failed')
    const path = output.trim()
    if (path !== join(directory, Buffer.from(integrity.slice(7), 'base64').toString('hex') + '.tgz')) throw new Error('Invalid member archive receipt')
    return path
  } finally {
    clearTimeout(deadline)
    clearTimeout(transportDeadline)
    signal.removeEventListener('abort', cancel)
    child.stdin.destroy()
  }
}
