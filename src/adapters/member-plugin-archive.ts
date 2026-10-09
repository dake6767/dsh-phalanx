import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { DSH_CONTAINER_PROFILE } from '../dsh/profile-layout.js'
import { memberPluginArchiveWorker } from './member-plugin-archive-worker.js'
import type { ContainerConfig } from '../domain/community-config.js'
import { PLUGIN_UPLOAD_MAX_BYTES } from '../domain/plugin-library.js'
import { containerClientEnvironment } from './runtime-command.js'

/** Keep a checked local tarball: an expiring URL must never become a profile dependency. */
export async function receiveMemberPluginArchive(container: ContainerConfig, name: string, url: string, integrity: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const directory = join(DSH_CONTAINER_PROFILE, '.phalanx-market')
  const child = spawn(container.runtime, ['exec', '-i', name, 'node', '-e', memberPluginArchiveWorker, url, integrity, String(PLUGIN_UPLOAD_MAX_BYTES), directory],
    { env: containerClientEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''; let timedOut = false
  // Keep the exec transport alive until its worker acknowledges cancellation by exiting.
  // Killing only the podman client leaves an active process inside the container.
  const cancel = () => { child.stdin.end('cancel\n') }
  child.stdin.on('error', () => {})
  child.stdout.on('data', (chunk: Buffer) => { if (output.length + chunk.length > 4096) cancel(); else output += chunk.toString('utf8') })
  child.stderr.resume()
  signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
  const deadline = setTimeout(() => { timedOut = true; cancel() }, 35000)
  const transportDeadline = setTimeout(() => child.kill('SIGKILL'), 45000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    signal.throwIfAborted()
    if (timedOut || code !== 0) throw new Error('Member archive download failed')
    const path = output.trim()
    if (path !== join(directory, Buffer.from(integrity.slice(7), 'base64').toString('hex') + '.tgz')) throw new Error('Invalid member archive receipt')
    return path
  } finally { clearTimeout(deadline); clearTimeout(transportDeadline); signal.removeEventListener('abort', cancel); child.stdin.destroy() }
}
