import { randomBytes } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { COMMUNITY_ENVIRONMENT_PATHS } from '../dsh/community-environment.js'
import type { CommunityEnvironmentBackup } from '../domain/admin-contract.js'
import type { CommunityEnvironmentPort } from '../ports/community-environment.js'
import type { CommunityUserSpaceStoragePort } from '../ports/community-user-spaces.js'
import { assertOwnedDirectory } from './user-storage-guard.js'

interface Manifest { readonly version: 1, readonly username: string, readonly spaceId: string, readonly home: string, readonly paths: readonly string[], readonly restorePaths: readonly string[] }

/** Private recoverable copies; never follows member links or removes durable user data. */
export class FileCommunityEnvironment implements CommunityEnvironmentPort {
  private readonly root: string
  constructor(dataRoot: string, private readonly spaces: CommunityUserSpaceStoragePort) { this.root = resolve(dataRoot, 'environment-backups') }
  async backup(username: string, spaceId: string): Promise<CommunityEnvironmentBackup> {
    const { home, spaceId: current } = await this.spaces.prepare(username)
    if (current !== spaceId) throw new Error('User-space identity changed')
    const paths = await this.carriers(home)
    const restorePaths = await this.carriers(home, true)
    const id = randomBytes(16).toString('hex'); const location = join(this.root, spaceId, id)
    for (const path of [this.root, join(this.root, spaceId), location]) {
      try { await mkdir(path, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      assertOwnedDirectory(path)
      if (((await lstat(path)).mode & 0o077) !== 0) throw new Error('Environment backups require private directories')
    }
    const files = join(location, 'files'); await mkdir(files, { mode: 0o700 })
    for (const path of paths) {
      const source = join(home, path); await this.assertCopyable(source)
      const destination = join(files, path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await cp(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true, force: false, errorOnExist: true })
    }
    const manifest: Manifest = { version: 1, username, spaceId, home, paths, restorePaths }
    await writeFile(join(location, 'README.txt'), this.instructions(manifest, location), { mode: 0o600, flag: 'wx', flush: true })
    // A manifest exists only after the complete copy and restoration instructions are durable.
    await writeFile(join(location, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx', flush: true })
    return { id, location, restoreInstructionsPath: join(location, 'README.txt'), restoreInstructions: `Stop the platform service and the target container, then follow ${join(location, 'README.txt')}. Backups are retained until the deployer removes them explicitly.` }
  }
  async reset(username: string, spaceId: string, backup: CommunityEnvironmentBackup): Promise<void> {
    const { home, spaceId: current } = await this.spaces.prepare(username)
    if (current !== spaceId || !/^[a-f0-9]{32}$/u.test(backup.id) || backup.location !== join(this.root, spaceId, backup.id)) throw new Error('Backup identity changed')
    assertOwnedDirectory(backup.location)
    const manifest = JSON.parse(await readFile(join(backup.location, 'manifest.json'), 'utf8')) as Manifest
    if (manifest.version !== 1 || manifest.username !== username || manifest.spaceId !== spaceId || manifest.home !== home) throw new Error('Backup does not match the current user space')
    const paths = await this.carriers(home)
    if (JSON.stringify(paths) !== JSON.stringify(manifest.paths)) throw new Error('Configuration carriers changed after backup; retry to create a new backup')
    for (const path of paths) await rm(join(home, path), { recursive: true, force: true })
  }
  private async carriers(home: string, includeMissing = false): Promise<string[]> {
    const selected = new Set<string>()
    for (const carrier of COMMUNITY_ENVIRONMENT_PATHS) {
      const parts = carrier.split('/'); let path = home
      for (let i = 0; i < parts.length; i++) {
        path = join(path, parts[i]!)
        let info
        try { info = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (includeMissing) selected.add(carrier); break } throw error }
        if (i === parts.length - 1 || !info.isDirectory()) { selected.add(relative(home, path)); break }
      }
    }
    const paths = [...selected].sort()
    return paths.filter(path => !paths.some(parent => path !== parent && path.startsWith(parent + sep)))
  }
  private async assertCopyable(path: string): Promise<void> {
    const info = await lstat(path)
    if (info.isSymbolicLink() || info.isFile()) return
    if (!info.isDirectory()) throw new Error('Configuration contains a special file; resolve it before making a backup')
    for (const name of await readdir(path)) await this.assertCopyable(join(path, name))
  }
  private instructions(manifest: Manifest, location: string): string {
    return `DSH environment backup (contains private member configuration and possibly credentials)\nUsername: ${manifest.username}\nSpace ID: ${manifest.spaceId}\nHome: ${manifest.home}\nBackup: ${location}\n\n1. Stop the dsh-phalanx platform service. Platform shutdown may leave containers running.\n2. As the platform service account, inspect and stop/remove ONLY the target container belonging to this platform data root and this username. Verify it is absent before touching files. In development mode verify the target DSH process exited.\n3. Move each current carrier below to a separate private recovery copy before restoring; this also preserves any new data inside a formerly linked parent. Do not discard that copy. Do not remove the home, workspace, session data or any other member's files.\n4. For each relative path below, after preserving its current carrier, restore a PRESENT carrier from backup files/<relative path> to the same home-relative location, preserving links and ownership (cp -a). Leave an ABSENT carrier absent. Create missing parent directories only under this home; never traverse a symlink.\n${manifest.restorePaths.map(path => `   ${path}: ${manifest.paths.includes(path) ? 'PRESENT' : 'ABSENT'}`).join('\n')}\n5. Restart the platform service, sign in and enter the same space. Restoring this backup restores the old configuration, including its fault; repair that fault before retrying startup. Do not overwrite the account database, space ID or platform-managed model/plugin files.\n\nA linked parent is backed up as a link only; its destination was neither read nor reset. Keep this backup private. No automatic backup cleanup runs.\n`
  }
}
