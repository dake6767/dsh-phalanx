import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createConnection } from 'node:net'

export interface DeploymentFacts {
  state: string
  status: string
  changed: boolean
  conflict?: boolean
  databaseSelection?: string | null
  components: { name: string; state: string; autostart?: string; ready?: boolean }[]
  errors: { component: string; reason: string }[]
  steps?: { component: string; action: string; status: string }[]
}
export interface CommandResult {
  exitCode: number
  result: DeploymentFacts
}
interface Prepared {
  origin: string
  dataRoot: string
  userDataRoot: string
  source: string
  receiptSha256: string
  autostart: Record<string, string>
}
interface Responses {
  prepare: Prepared
  restore: { restored: boolean; autostartPreserved?: boolean; source?: string }
  start: CommandResult
  stop: CommandResult
  status: CommandResult
  'query-failed-status': CommandResult
  'partial-stop': CommandResult
  'hold-lock': { held: boolean }
  'release-lock': { released: boolean }
  maintenance: { created: boolean }
  'clear-maintenance': { cleared: boolean }
  'detach-platform': { detached: boolean }
  'orphan-maintenance': { created: boolean }
  'audit-stopped': { stopped: boolean; serviceTasks: number; memberTasks: number; maintenanceDescriptors: number }
  'member-counts': { resident: number; ondemand: number; disabled: number }
  heartbeat: { bytes: number }
}

/** Private, peer-checked acceptance capability. No arbitrary command or host path is accepted. */
export async function deploymentControl() {
  const path = process.env.DSH_PHALANX_LIFECYCLE_CONTROL
  if (!path) throw Error('A root-owned lifecycle guardian is required')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let input: { socket: string; token: string }
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 4096) throw Error('Invalid lifecycle capability file')
    input = JSON.parse(await file.readFile('utf8')) as typeof input
    if (typeof input.socket !== 'string' || !/^[a-f0-9]{64}$/u.test(input.token)) throw Error('Invalid lifecycle capability')
  } finally {
    await file.close()
  }
  let buffer = '',
    pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined
  const socket = createConnection(input.socket)
  socket.setEncoding('utf8')
  const fail = (error: Error) => {
    pending?.reject(error)
    pending = undefined
  }
  socket.on('error', fail)
  socket.on('close', () => fail(Error('Lifecycle guardian disconnected')))
  socket.on('data', part => {
    buffer += part.toString()
    if (buffer.length > 1048576) {
      fail(Error('Lifecycle response exceeded its bound'))
      socket.destroy()
      return
    }
    const end = buffer.indexOf('\n')
    if (end < 0 || !pending) return
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    const request = pending
    pending = undefined
    try {
      const response = JSON.parse(line) as { ok: boolean; result?: unknown; errorType?: string; phase?: string }
      if (!response.ok) request.reject(Error('Lifecycle guardian action failed: ' + response.errorType + ' during ' + response.phase))
      else request.resolve(response.result)
    } catch {
      request.reject(Error('Malformed lifecycle response'))
    }
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(Error('Lifecycle connection deadline'))
    }, 10000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return {
    request<Action extends keyof Responses>(action: Action): Promise<Responses[Action]> {
      if (pending || socket.destroyed) throw Error('Lifecycle commands require a connected, sequential session')
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          fail(Error('Lifecycle guardian deadline'))
          socket.destroy()
        }, 240_000)
        pending = {
          resolve: value => {
            clearTimeout(timer)
            resolve(value as Responses[Action])
          },
          reject: error => {
            clearTimeout(timer)
            reject(error)
          },
        }
        socket.write(JSON.stringify({ token: input.token, action }) + '\n')
      })
    },
    close() {
      socket.destroy()
    },
  }
}
