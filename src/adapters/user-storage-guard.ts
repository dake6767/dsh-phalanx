import { randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { renameSync, rmSync } from 'node:fs'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'

interface StorageBinding { readonly path: string, readonly id: string, readonly mount: string }
interface StorageMarker { readonly id: string, readonly owner: string }

/** Binds an explicitly configured existing volume to this platform before admission. */
export class UserStorageGuard {
  private readonly binding: StorageBinding | undefined
  private readonly owner: string | undefined
  constructor(dataRoot: string, private readonly userDataRoot?: string, private readonly requireMount = false, private readonly expectedMount?: string) {
    const bindingPath = join(dataRoot, 'user-storage.json')
    try {
      if (userDataRoot === undefined) {
        if (this.expectedMount !== undefined) throw new Error('A user data mount requires a user data root')
        if (existsSync(bindingPath)) throw new Error('Configured user storage must not be omitted')
        return
      }
      assertOwnedDirectory(userDataRoot)
      const path = realpathSync(userDataRoot)
      const platform = realpathSync(dataRoot)
      if (path === platform || path.startsWith(`${platform}${sep}`) || platform.startsWith(`${path}${sep}`)) throw new Error('Platform and external user storage must not overlap')
      const mount = mountIdentity(path, this.requireMount, this.expectedMount)
      const markerPath = join(path, '.dsh-phalanx-storage.json')
      this.owner = platformIdentity(join(dataRoot, 'user-storage-identity'), existsSync(markerPath) || existsSync(bindingPath))
      if (existsSync(bindingPath)) {
        assertPrivateFile(bindingPath)
        const value: unknown = JSON.parse(readFileSync(bindingPath, 'utf8'))
        if (!record(value) || typeof value.path !== 'string' || typeof value.id !== 'string' || typeof value.mount !== 'string') throw new Error('Invalid storage binding')
        this.binding = { path: value.path, id: value.id, mount: value.mount }
      } else {
        const previous = join(dataRoot, 'users')
        if (existsSync(previous) && readdirSync(previous).length > 0 && realpathSync(previous) !== path) {
          throw new Error('Existing user data requires an explicit storage migration')
        }
        if (!existsSync(markerPath) && readdirSync(path).length > 0) throw new Error('New user storage must be empty; existing data requires explicit migration')
        const marker = existsSync(markerPath) ? readMarker(markerPath) : { id: randomBytes(16).toString('hex'), owner: this.owner }
        if (marker.owner !== this.owner) throw new Error('User storage belongs to another platform')
        if (!existsSync(markerPath)) writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600, flag: 'wx' })
        this.binding = { path, id: marker.id, mount }
        writeFileSync(bindingPath, JSON.stringify(this.binding), { mode: 0o600, flag: 'wx' })
      }
      this.assertAvailable()
    } catch (cause) { throw unavailable(cause) }
  }

  assertAvailable(): void {
    if (this.binding === undefined || this.userDataRoot === undefined) return
    try {
      assertOwnedDirectory(this.userDataRoot)
      const path = realpathSync(this.userDataRoot)
      const marker = readMarker(join(path, '.dsh-phalanx-storage.json'))
      if (path !== this.binding.path || mountIdentity(path, this.requireMount, this.expectedMount) !== this.binding.mount
        || marker.id !== this.binding.id || marker.owner !== this.owner) throw new Error('User storage identity changed')
    } catch (cause) { throw unavailable(cause) }
  }
}

/** Offline migration reuses the same ownership and mount binding grammar. */
export class UserStorageBindingMigration {
  readonly path: string
  readonly mount: string
  private readonly owner: string
  constructor(private readonly dataRoot: string, target: string, expectedMount: string) {
    assertOwnedDirectory(dataRoot)
    const requested = resolve(target)
    assertOwnedDirectory(dirname(requested))
    if (realpathSync(dirname(requested)) !== dirname(requested)) throw new Error('Migration target parents must not be symbolic links')
    this.path = requested
    const platform = realpathSync(dataRoot)
    if (requested === platform || requested.startsWith(`${platform}${sep}`) || platform.startsWith(`${requested}${sep}`)) throw new Error('Platform and external user storage must not overlap')
    if (requested === realpathSync(expectedMount)) throw new Error('Migration target must be a directory below the mounted volume')
    this.mount = mountIdentity(dirname(requested), true, expectedMount)
    this.owner = platformIdentity(join(dataRoot, 'user-storage-identity'), existsSync(join(dataRoot, 'user-storage.json')))
  }
  publish(id: string): void {
    if (!/^[a-f0-9]{32}$/u.test(id)) throw new Error('Invalid migration identity')
    assertOwnedDirectory(this.path)
    if (mountIdentity(this.path, true, JSON.parse(this.mount).path as string) !== this.mount) throw new Error('Migration mount changed')
    atomicPrivateFile(join(this.path, '.dsh-phalanx-storage.json'), JSON.stringify({ id, owner: this.owner }))
    atomicPrivateFile(join(this.dataRoot, 'user-storage.json'), JSON.stringify({ path: this.path, id, mount: this.mount }))
  }
}

export function atomicPrivateFile(path: string, value: string): void {
  const staging = `${path}.tmp-${randomBytes(16).toString('hex')}`
  try { writeFileSync(staging, value, { flag: 'wx', mode: 0o600, flush: true }); renameSync(staging, path) }
  finally { rmSync(staging, { force: true }) }
}

export function assertPrivateFile(path: string): void {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('Invalid private storage metadata ownership')
}

function platformIdentity(path: string, previouslyBound: boolean): string {
  if (!existsSync(path)) {
    if (previouslyBound) throw new Error('Restore the original platform storage identity before attaching existing user storage')
    writeFileSync(path, randomBytes(16).toString('hex'), { mode: 0o600, flag: 'wx', flush: true })
  }
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('Invalid platform storage identity ownership')
  const identity = readFileSync(path, 'utf8')
  if (!/^[a-f0-9]{32}$/u.test(identity)) throw new Error('Invalid platform storage identity')
  return identity
}

export function assertOwnedDirectory(path: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || (info.mode & 0o022) !== 0 || (info.mode & 0o700) !== 0o700) throw new Error('Storage must be a private writable directory owned by the service account')
  accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK)
}

function readMarker(path: string): StorageMarker {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('Invalid storage marker ownership')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!record(value) || typeof value.id !== 'string' || !/^[a-f0-9]{32}$/u.test(value.id) || typeof value.owner !== 'string') throw new Error('Invalid storage marker')
  return { id: value.id, owner: value.owner }
}

function mountIdentity(path: string, requireMount: boolean, expectedMount?: string): string {
  if (process.platform !== 'linux') {
    if (requireMount) throw new Error('External container storage requires a Linux mount')
    return `development:${process.platform}`
  }
  const unescape = (value: string) => value.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map(line => {
    const [left, right] = line.split(' - ')
    const fields = left!.split(' '); const source = right!.split(' ')
    return { path: unescape(fields[4]!), source: unescape(source[1]!), type: source[0]! }
  }).filter(mount => mount.path === '/' || path === mount.path || path.startsWith(`${mount.path}${sep}`))
  const mount = mounts.sort((a, b) => b.path.length - a.path.length)[0]
  if (mount === undefined || (requireMount && mount.path === '/')) throw new Error('External user storage requires an already mounted volume outside the system root')
  if (requireMount && expectedMount === undefined) throw new Error('External user storage requires an explicit expected mount point')
  if (expectedMount !== undefined && (mount.path !== realpathSync(expectedMount) || mount.path === '/')) throw new Error('Expected user data volume is not mounted')
  return JSON.stringify(mount)
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function unavailable(cause: unknown) {
  return new CommunityRuntimeUnavailableError('storage-unavailable', 'User data storage is unavailable; restore the configured mount, ownership and storage identity before retrying', { cause })
}
