import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { COMMUNITY_ENVIRONMENT_PATHS } from '../dsh/community-environment.js'

export interface EnvironmentBackupManifest {
  readonly version: 2
  readonly username: string
  readonly spaceId: string
  readonly home: string
  readonly paths: readonly string[]
  readonly restorePaths: readonly string[]
  readonly completedAt?: number
}
interface Candidate {
  readonly id: string
  readonly path: string
  readonly at: number
  readonly directory: string
  readonly manifest: string
}

/** Only complete, private copies for this exact platform space participate in retention. */
export async function retainEnvironmentBackups(root: string, expected: EnvironmentBackupManifest, currentId: string): Promise<void> {
  try {
    if (!/^[a-f0-9]{32}$/u.test(expected.spaceId)) throw invalid()
    const parent = join(root, expected.spaceId),
      rootKey = key(await directory(root)),
      parentKey = key(await directory(parent))
    const current = await candidate(parent, currentId, expected)
    const previous: Candidate[] = []
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (entry.name === currentId || !entry.isDirectory() || !/^[a-f0-9]{32}$/u.test(entry.name)) continue
      try {
        previous.push(await candidate(parent, entry.name, expected))
      } catch {
        /* Unknown or incomplete directories are retained. */
      }
    }
    previous.sort((left, right) => right.at - left.at || left.id.localeCompare(right.id))
    const keep = new Set([current.id, ...previous.slice(0, 2).map(row => row.id)])
    for (const old of previous) {
      if (keep.has(old.id)) continue
      try {
        if (key(await directory(root)) !== rootKey || key(await directory(parent)) !== parentKey) throw invalid()
        const latest = await candidate(parent, old.id, expected)
        if (latest.directory !== old.directory || latest.manifest !== old.manifest) throw invalid()
        await rm(old.path, { recursive: true, force: true })
      } catch {
        console.warn('Environment backup cleanup failed')
      }
    }
  } catch {
    console.warn('Environment backup cleanup could not verify its scope; retained existing backups')
  }
}
async function candidate(parent: string, id: string, expected: EnvironmentBackupManifest): Promise<Candidate> {
  if (!/^[a-f0-9]{32}$/u.test(id)) throw invalid()
  const path = join(parent, id),
    info = await directory(path)
  const file = await open(join(path, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await file.stat()
    if (!privateFile(metadata) || metadata.size > 1_000_000) throw invalid()
    const manifest: unknown = JSON.parse(await file.readFile('utf8'))
    if (
      !record(manifest) ||
      manifest.version !== 2 ||
      manifest.username !== expected.username ||
      manifest.spaceId !== expected.spaceId ||
      manifest.home !== expected.home ||
      !paths(manifest.paths) ||
      !paths(manifest.restorePaths) ||
      !manifest.paths.every(value => (manifest.restorePaths as string[]).includes(value)) ||
      !COMMUNITY_ENVIRONMENT_PATHS.every(carrier => (manifest.restorePaths as string[]).some(value => carrier === value || carrier.startsWith(value + '/')))
    )
      throw invalid()
    const at = manifest.completedAt === undefined ? metadata.mtimeMs : manifest.completedAt
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || (manifest.completedAt !== undefined && !Number.isSafeInteger(at))) throw invalid()
    if (!privateFile(await lstat(join(path, 'README.txt')))) throw invalid()
    const files = join(path, 'files')
    await directory(files)
    for (const relative of manifest.paths) {
      let copied = files
      const parts = relative.split('/')
      for (let index = 0; index < parts.length; index++) {
        copied = join(copied, parts[index]!)
        const item = await lstat(copied)
        if (index === parts.length - 1 ? !item.isFile() && !item.isDirectory() && !item.isSymbolicLink() : !item.isDirectory() || item.isSymbolicLink())
          throw invalid()
      }
    }
    return { id, path, at, directory: key(info), manifest: `${key(metadata)}:${metadata.size}:${metadata.mtimeMs}` }
  } finally {
    await file.close()
  }
}
async function directory(path: string): Promise<Stats> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || (info.mode & 0o500) !== 0o500)
    throw invalid()
  return info
}
function privateFile(info: Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0 && info.size > 0
}
function paths(input: unknown): input is string[] {
  return (
    Array.isArray(input) &&
    new Set(input).size === input.length &&
    input.every(
      value =>
        typeof value === 'string' &&
        COMMUNITY_ENVIRONMENT_PATHS.some(carrier => carrier === value || carrier.startsWith(value + '/')) &&
        !input.some(other => other !== value && typeof other === 'string' && value.startsWith(other + '/')),
    )
  )
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function key(info: Stats): string {
  return `${info.dev}:${info.ino}`
}
function invalid() {
  return new Error('Unverified environment backup scope')
}
