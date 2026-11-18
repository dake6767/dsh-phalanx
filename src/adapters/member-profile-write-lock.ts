import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'
import { DSH_PROFILE_MANIFEST, dshHomePath, dshProfilesPath, dshWebProfilePath } from '../dsh/profile-layout.js'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'
import { assertOwnedDirectory } from './user-storage-files.js'
import { disposeProfileLock, profileLockDispositionPending } from './profile-lock-disposition.js'

const lockName = DSH_PROFILE_MANIFEST + '.lock'

export type MemberProfileLockEvidence =
  { readonly state: 'active' | 'unknown' } | { readonly state: 'exited'; readonly startedAt: number; readonly finishedAt: number }

export interface ProfileLock {
  readonly path: string
  readonly profile: string
  readonly identity: string
  readonly holder: number
  readonly bornAt: number
  readonly changedAt: number
}

export function profileHomeIdentity(home: string): string {
  assertOwnedDirectory(home)
  const { dev, ino, birthtimeNs } = statSync(home, { bigint: true })
  if (birthtimeNs <= 0n) throw new Error('Member home has no stable creation identity')
  return `${dev}:${ino}:${birthtimeNs}`
}

function identity(info: BigIntStats): string {
  return [info.dev, info.ino, info.uid, info.mode, info.size, info.nlink, info.birthtimeNs, info.mtimeNs, info.ctimeNs].join(':')
}

function ownedProfileDirectory(home: string): string {
  try {
    assertOwnedDirectory(home)
    const canonicalHome = realpathSync(home)
    const profile = dshWebProfilePath(canonicalHome)
    for (const directory of [canonicalHome, dshHomePath(canonicalHome), dshProfilesPath(canonicalHome), profile]) {
      assertOwnedDirectory(directory)
    }
    return profile
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error
    throw new CommunityRuntimeUnavailableError('profile-unavailable', 'Private DSH profile could not be prepared; repair its configuration before retrying', {
      cause: error,
    })
  }
}

function openProfileLock(home: string): { lock: ProfileLock; fd: number } {
  const profile = ownedProfileDirectory(home)
  const { dev, ino } = statSync(profile, { bigint: true })
  const path = join(profile, lockName)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd, { bigint: true })
    if (
      !info.isFile() ||
      info.uid !== BigInt(process.getuid!()) ||
      (info.mode & 0o077n) !== 0n ||
      info.nlink !== 1n ||
      info.size < 2n ||
      info.size > 11n ||
      info.birthtimeNs <= 0n
    )
      throw new Error('Unknown profile lock identity')
    const content = Buffer.alloc(12)
    const size = readSync(fd, content, 0, content.length, 0)
    const record = content.toString('utf8', 0, size)
    const holder = Number(record)
    if (!/^[1-9][0-9]{0,9}\n$/u.test(record) || holder > 0x7fff_ffff) throw new Error('Unknown profile lock record')
    const fingerprint = identity(info)
    if (fingerprint !== identity(fstatSync(fd, { bigint: true }))) throw new Error('Profile lock changed while reading')
    return {
      fd,
      lock: {
        path,
        profile: `${dev}:${ino}`,
        identity: fingerprint + ':' + record,
        holder,
        bornAt: Number(info.birthtimeNs) / 1e6,
        changedAt: Number(info.ctimeNs) / 1e6,
      },
    }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

export function readProfileLock(home: string): ProfileLock {
  const { fd, lock } = openProfileLock(home)
  closeSync(fd)
  return lock
}

export function restoreInterruptedProfileLock(home: string): void {
  if (!profileLockDispositionPending(home)) return
  try {
    if (disposeProfileLock(ownedProfileDirectory(home), home, lockName) === 'restored') return
  } catch (error) {
    if (error instanceof CommunityRuntimeUnavailableError) throw error
    // Keep an unresolved transaction intact when its original directory is unavailable.
  }
  throw new Error('Retained unresolved profile lock recovery state')
}

/** The caller proves exclusive ownership and serializes admission of the next writer. */
export async function recoverMemberProfileWriteLock(home: string, evidence: (lock: ProfileLock) => Promise<MemberProfileLockEvidence>) {
  let opened: ReturnType<typeof openProfileLock>
  try {
    restoreInterruptedProfileLock(home)
    opened = openProfileLock(home)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown'
  }
  const { lock: original, fd } = opened
  try {
    const carrier = await evidence(original).catch((): MemberProfileLockEvidence => ({ state: 'unknown' }))
    if (carrier.state !== 'exited') return carrier.state
    if (
      !Number.isFinite(carrier.startedAt) ||
      !Number.isFinite(carrier.finishedAt) ||
      original.bornAt < carrier.startedAt ||
      original.changedAt > carrier.finishedAt
    )
      return 'unknown'
    if (`${identity(fstatSync(fd, { bigint: true }))}:${original.holder}\n` !== original.identity) return 'changed'
    return disposeProfileLock(dirname(original.path), home, lockName, { fd, pid: original.holder, profile: original.profile })
  } catch {
    return 'unknown'
  } finally {
    closeSync(fd)
  }
}
