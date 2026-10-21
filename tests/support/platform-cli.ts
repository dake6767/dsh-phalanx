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
  let stderr = ''
  child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-4096) })
  const diagnostic = () => {
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
