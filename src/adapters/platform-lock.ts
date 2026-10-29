import { closeSync, mkdirSync, openSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

export class PlatformMaintenanceBusyError extends Error {
  constructor() {
    super('another platform process already owns this data root')
  }
}

/** The local mutex path; the upgrader takes the same flock on this file. */
export const PLATFORM_LOCK_FILE = 'platform.lock'

// Node has no flock. A host python3 locks this process's descriptor and exits;
// flock belongs to the open file, so the lock lasts until the descriptor closes or the process dies.
const LOCK = 'import fcntl,sys\ntry: fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(75)'

/** An exclusive, non-blocking OS lock on the data root, released on close and process death. */
export class PlatformLock {
  private readonly descriptor: number
  private closed = false
  constructor(dataRoot: string) {
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
    const descriptor = openSync(join(dataRoot, PLATFORM_LOCK_FILE), 'a', 0o600)
    const result = spawnSync('python3', ['-I', '-c', LOCK], { stdio: ['ignore', 'ignore', 'pipe', descriptor] })
    if (result.status !== 0) {
      closeSync(descriptor)
      if (result.status === 75) throw new PlatformMaintenanceBusyError()
      throw Error('Platform lock could not be acquired: ' + (result.error?.message ?? result.stderr?.toString().trim() ?? 'unknown'))
    }
    this.descriptor = descriptor
  }
  close(): void {
    if (this.closed) return
    closeSync(this.descriptor)
    this.closed = true
  }
}
