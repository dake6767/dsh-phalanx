import { createHash } from 'node:crypto'
import { chmodSync, closeSync, cpSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readlinkSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

/** Offline copy preserves directory modes too; recursive cp alone does not. */
export function copyUserStorage(source: string, target: string): void {
  const info = lstatSync(source)
  if (info.uid !== process.getuid?.()) throw new Error('Migration data must be owned by the service account')
  if (info.isDirectory()) {
    mkdirSync(target, { mode: 0o700 })
    for (const name of readdirSync(source)) copyUserStorage(join(source, name), join(target, name))
    chmodSync(target, info.mode & 0o777); utimesSync(target, info.atime, info.mtime)
  } else if (info.isFile() || info.isSymbolicLink()) {
    cpSync(source, target, { dereference: false, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false })
  } else throw new Error('Migration cannot copy special files; retain the source and remove the obstruction explicitly')
}

/** Independent inventory of types, modes, link text and file bytes; never follows links. */
export function userStorageInventory(root: string): string {
  const rows: unknown[] = []
  const visit = (path: string, relative: string) => {
    const info = lstatSync(path)
    if (info.uid !== process.getuid?.()) throw new Error('Migration data must be owned by the service account')
    if (info.isSymbolicLink()) { rows.push([relative, 'link', readlinkSync(path)]); return }
    if (info.isFile()) { rows.push([relative, 'file', info.mode & 0o777, info.size, hashFile(path)]); return }
    if (!info.isDirectory()) throw new Error('Migration cannot copy special files; retain the source and remove the obstruction explicitly')
    rows.push([relative, 'directory', info.mode & 0o777])
    for (const name of readdirSync(path).sort()) {
      if (relative === '' && name === '.dsh-phalanx-storage.json') continue
      visit(join(path, name), relative === '' ? name : `${relative}/${name}`)
    }
  }
  visit(root, '')
  return JSON.stringify(rows)
}
function hashFile(path: string): string {
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), file = openSync(path, 'r')
  try { let count: number; while ((count = readSync(file, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count)) }
  finally { closeSync(file) }
  return hash.digest('hex')
}
