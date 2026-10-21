import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EnvironmentResetHistory } from '../domain/environment-reset-history.js'
import type { EnvironmentResetHistoryPort } from '../ports/environment-reset-history.js'
import { assertOwnedDirectory, atomicPrivateFile } from './user-storage-guard.js'

/** One bounded latest record per stable space, replaced atomically before reset effects. */
export class FileEnvironmentResetHistory implements EnvironmentResetHistoryPort {
  private spaces: Readonly<Record<string, EnvironmentResetHistory>>
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); assertOwnedDirectory(dirname(path))
    let descriptor: number | undefined
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = fstatSync(descriptor)
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw invalid()
      this.spaces = normalize(JSON.parse(readFileSync(descriptor, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.spaces = normalize({ version: 1, spaces: {} })
      atomicPrivateFile(path, JSON.stringify({ version: 1, spaces: this.spaces }))
    } finally { if (descriptor !== undefined) closeSync(descriptor) }
  }
  get(spaceId: string): EnvironmentResetHistory | undefined { identity(spaceId); return this.spaces[spaceId] }
  save(spaceId: string, record: EnvironmentResetHistory): void {
    identity(spaceId)
    const next = normalize({ version: 1, spaces: { ...this.spaces, [spaceId]: record } })
    assertOwnedDirectory(dirname(this.path))
    atomicPrivateFile(this.path, JSON.stringify({ version: 1, spaces: next }))
    this.spaces = next
  }
}
function normalize(input: unknown): Readonly<Record<string, EnvironmentResetHistory>> {
  if (!object(input) || input.version !== 1 || !object(input.spaces)) throw invalid()
  return Object.freeze(Object.fromEntries(Object.entries(input.spaces).map(([spaceId, record]) => {
    identity(spaceId)
    if (!object(record) || !object(record.recent)) throw invalid()
    const { at, username, role } = record.recent, last = record.lastMemberAcceptedAt
    if (!timestamp(at) || typeof username !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(username) || role !== 'admin' && role !== 'member' || last !== undefined && !timestamp(last)) throw invalid()
    return [spaceId, Object.freeze({ ...(last === undefined ? {} : { lastMemberAcceptedAt: last }), recent: Object.freeze({ at, username, role }) })]
  })))
}
function identity(value: string): void { if (!/^[a-f0-9]{32}$/u.test(value)) throw invalid() }
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function invalid() { return new Error('Invalid private environment reset history') }
