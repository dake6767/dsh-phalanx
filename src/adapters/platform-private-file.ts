import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readPlatformPrivateFile(path: string, limit = 262144): string {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(file)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > limit)
      throw Error('Invalid protected platform operation file')
    return readFileSync(file, 'utf8')
  } finally {
    closeSync(file)
  }
}
export function writePlatformPrivateFile(path: string, value: string, previous?: string): void {
  const staging = path + '.tmp-' + randomUUID()
  const file = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeFileSync(file, value)
    fsyncSync(file)
    if (previous === undefined) linkSync(staging, path)
    else {
      if (readPlatformPrivateFile(path) !== previous) throw Error('Protected operation ownership changed')
      renameSync(staging, path)
    }
    syncPlatformDirectory(dirname(path))
  } finally {
    closeSync(file)
    rmSync(staging, { force: true })
  }
}
export function syncPlatformDirectory(path: string): void {
  const directory = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

export function platformFileExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
