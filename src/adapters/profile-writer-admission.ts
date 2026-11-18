import { randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { KeyedOperations } from '../domain/keyed-operations.js'
import { assertOwnedDirectory, assertPrivateFile, atomicPrivateFile } from './user-storage-files.js'
import { profileLockDispositionPending } from './profile-lock-disposition.js'

const admissions = new KeyedOperations()
const active = new Map<string, number>()

function stampFile(home: string): string {
  const space = dirname(home)
  assertOwnedDirectory(space)
  return join(space, '.profile-writer-revision')
}

function updateRevision(home: string): string {
  const path = stampFile(home)
  const stamp = randomUUID()
  atomicPrivateFile(path, stamp)
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
  return stamp
}

function revision(home: string): string {
  const path = stampFile(home)
  try {
    assertPrivateFile(path)
    const value = readFileSync(path, 'utf8')
    if (!/^[a-f0-9-]{36}$/u.test(value)) throw new Error('Invalid profile writer revision')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return updateRevision(home)
  }
}

/** Serialize inspection and retirement against new independently mounted writers. */
export function withProfileWriterAdmission<T>(home: string, operation: (state: { active: boolean; revision?: string }) => Promise<T>): Promise<T> {
  let key = resolve(home)
  try {
    key = realpathSync(home)
  } catch {
    // The carrier still needs to stop when its home cannot be authenticated.
  }
  return admissions.run(key, async () => {
    let current: string | undefined
    try {
      current = revision(key)
    } catch {
      // Startup or shutdown can proceed with no proof authorizing lock removal.
    }
    return operation({ active: active.has(key), ...(current ? { revision: current } : {}) })
  })
}

/** An execution is allowed alongside a carrier. Its durable admission invalidates that carrier's exclusive history. */
export async function runIndependentProfileWriter<T>(home: string, run: () => Promise<T>): Promise<T> {
  const key = realpathSync(home)
  await admissions.run(key, async () => {
    if (profileLockDispositionPending(key)) throw new Error('Member profile recovery has not finished')
    updateRevision(key)
    active.set(key, (active.get(key) ?? 0) + 1)
  })
  try {
    return await run()
  } finally {
    const remaining = active.get(key)! - 1
    if (remaining === 0) active.delete(key)
    else active.set(key, remaining)
  }
}
