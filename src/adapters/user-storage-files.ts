import { randomBytes } from 'node:crypto'
import { accessSync, constants, linkSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { sep } from 'node:path'

export interface UserStorageMarker {
  readonly id: string
  readonly owner: string
}

export function atomicPrivateFile(path: string, value: string): void {
  const staging = `${path}.tmp-${randomBytes(16).toString('hex')}`
  try {
    writeFileSync(staging, value, { flag: 'wx', mode: 0o600, flush: true })
    renameSync(staging, path)
  } finally {
    rmSync(staging, { force: true })
  }
}

export function assertPrivateFile(path: string): void {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error('Invalid private storage metadata ownership')
}

export function assertOwnedDirectory(path: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0 || (info.mode & 0o700) !== 0o700)
    throw new Error('Storage must be a private writable directory owned by the service account')
  accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK)
}

export function readStorageMarker(path: string): UserStorageMarker {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error('Invalid storage marker ownership')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!record(value) || typeof value.id !== 'string' || !/^[a-f0-9]{32}$/u.test(value.id) || typeof value.owner !== 'string')
    throw new Error('Invalid storage marker')
  return { id: value.id, owner: value.owner }
}

export function mountIdentity(path: string, requireMount: boolean, expectedMount?: string): string {
  if (process.platform !== 'linux') {
    if (requireMount) throw new Error('External container storage requires a Linux mount')
    return `development:${process.platform}`
  }
  const unescape = (value: string) => value.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
    .trim()
    .split('\n')
    .map(line => {
      const [left, right] = line.split(' - ')
      const fields = left!.split(' ')
      const source = right!.split(' ')
      return { path: unescape(fields[4]!), source: unescape(source[1]!), type: source[0]! }
    })
    .filter(mount => mount.path === '/' || path === mount.path || path.startsWith(`${mount.path}${sep}`))
  const mount = mounts.sort((a, b) => b.path.length - a.path.length)[0]
  if (mount === undefined || (requireMount && mount.path === '/'))
    throw new Error('External user storage requires an already mounted volume outside the system root')
  if (requireMount && expectedMount === undefined) throw new Error('External user storage requires an explicit expected mount point')
  if (expectedMount !== undefined && (mount.path !== realpathSync(expectedMount) || mount.path === '/'))
    throw new Error('Expected user data volume is not mounted')
  return JSON.stringify(mount)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Atomically publish a new marker without replacing a concurrently existing identity. */
export function createStorageMarker(path: string, marker: UserStorageMarker): UserStorageMarker {
  const staging = `${path}.tmp-${randomBytes(16).toString('hex')}`
  try {
    writeFileSync(staging, JSON.stringify(marker), { flag: 'wx', mode: 0o600, flush: true })
    try {
      linkSync(staging, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    rmSync(staging, { force: true })
  }
  return readStorageMarker(path)
}
