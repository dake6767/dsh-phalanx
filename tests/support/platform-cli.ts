import { spawn } from 'node:child_process'

/** Own the test CLI process group and its readiness/cleanup handshakes. */
export async function startPlatformCli(command: string, args: readonly string[], environment: Readonly<Record<string, string>>, startupTimeoutMs = 30_000) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_PHALANX_')))
  const child = spawn(command, [...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...inherited, ...environment } })
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
  const stop = async (): Promise<void> => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM')
    await exited
  }
  let stderr = '', omitted = false
  child.stderr?.on('data', data => {
    if (omitted) return
    const next = stderr + String(data)
    // Never retain a fragment whose credential prefix may have been discarded.
    if (next.length > 4096) { omitted = true; stderr = '' }
    else stderr = next
  })
  const diagnostic = () => {
    if (omitted) return '[stderr omitted: output exceeded 4096 characters]'
    let text = stderr
    for (const [key, value] of Object.entries({ ...inherited, ...environment })) {
      if (/secret|token|key|password|credential/iu.test(key) && value && value.length >= 4) text = text.split(value).join('[redacted]')
    }
    return text.replace(/([?&#](?:token|credential|api_key|key)=)[^\s&#]+/giu, '$1[redacted]')
      .replace(/(Bearer\s+)[^\s]+/giu, '$1[redacted]').replace(/(https?:\/\/)[^/\s@]+@/giu, '$1[redacted]@').trim()
  }
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      let output = ''
      deadline = setTimeout(() => { reject(new Error(`Platform command did not report readiness within ${startupTimeoutMs} ms`)) }, startupTimeoutMs)
      child.once('error', reject)
      child.once('close', (code, signal) => reject(new Error(`Platform command exited before readiness (code ${code}, signal ${signal}): ${diagnostic()}`)))
      child.stdout?.on('data', data => {
        output += String(data)
        const match = /dsh-phalanx listening at (https?:\/\/[^\s]+)\r?\n/u.exec(output)
        if (match?.[1] !== undefined) resolve(match[1])
      })
    })
    return { origin, stop }
  } catch (error) { await stop(); throw error }
  finally { if (deadline !== undefined) clearTimeout(deadline) }
}
