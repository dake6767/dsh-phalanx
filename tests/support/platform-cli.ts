import { spawn } from 'node:child_process'

/** Own the test CLI process group and its readiness/cleanup handshakes. */
export async function startPlatformCli(command: string, args: readonly string[], environment: Readonly<Record<string, string>>) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_PHALANX_')))
  const child = spawn(command, [...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...inherited, ...environment } })
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
  const stop = async (): Promise<void> => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM')
    await exited
  }
  child.stderr?.resume()
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      let output = ''
      deadline = setTimeout(() => { reject(new Error('Platform command did not report readiness within 30 seconds')) }, 30_000)
      child.once('error', reject)
      child.once('exit', () => reject(new Error('Platform command exited before readiness')))
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
