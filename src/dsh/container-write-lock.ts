import { DSH_CONTAINER_HOME } from './profile-layout.js'

export const PROFILE_WRITER_HOME_LABEL = 'dsh-phalanx.profile-writer-home'

/** Only the Podman facts required to prove a predecessor's writable home and PID namespace. */
export const CONTAINER_WRITE_LOCK_FORMAT =
  '{"id":{{json .ID}},"state":{{json .State.Status}},"pid":{{.State.Pid}},"pidMode":{{json .HostConfig.PidMode}},' +
  '"started":{{json .State.StartedAt}},"finished":{{json .State.FinishedAt}},"mounts":{{json .Mounts}}}'

export interface ContainerWriteLockFacts {
  readonly id: string
  readonly state: string
  readonly pid: number
  readonly pidMode: string
  readonly startedAt: number
  readonly finishedAt: number
  readonly sources: readonly string[]
  readonly home?: string
}

interface Mount {
  readonly Type: string
  readonly Source: string
  readonly Destination: string
  readonly RW: boolean
}

function isMount(value: unknown): value is Mount {
  if (!value || typeof value !== 'object') return false
  const mount = value as Partial<Mount>
  return typeof mount.Type === 'string' && typeof mount.Source === 'string' && typeof mount.Destination === 'string' && typeof mount.RW === 'boolean'
}

export function parseContainerWriteLockFacts(output: string): ContainerWriteLockFacts[] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const { id, state, pid, pidMode, started, finished, mounts } = JSON.parse(line)
      if (
        typeof id !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(id) ||
        typeof state !== 'string' ||
        !Number.isSafeInteger(pid) ||
        pid < 0 ||
        typeof pidMode !== 'string' ||
        typeof started !== 'string' ||
        typeof finished !== 'string' ||
        !Array.isArray(mounts) ||
        !mounts.every(isMount)
      )
        throw new Error('Incomplete container writer facts')
      const writable: Mount[] = mounts.filter(mount => mount.RW)
      const homeBindings = writable.filter(mount => mount.Type === 'bind' && mount.Destination === DSH_CONTAINER_HOME)
      return {
        id,
        state,
        pid,
        pidMode,
        startedAt: Date.parse(started),
        finishedAt: Date.parse(finished),
        sources: writable.map(mount => mount.Source),
        ...(homeBindings.length === 1 ? { home: homeBindings[0]!.Source } : {}),
      }
    })
}
