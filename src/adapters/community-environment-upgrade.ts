import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CommunityEnvironmentBackup } from '../domain/admin-contract.js'
import type { CommunityEnvironmentUpgradeStorePort, CommunityEnvironmentUpgradeState } from '../ports/community-environment-upgrade.js'
import type { CommunityUserSpaceStoragePort } from '../ports/community-user-spaces.js'
import { dshHomePath } from '../dsh/profile-layout.js'
import { assertOwnedDirectory } from './user-storage-guard.js'

/** Per-space durable upgrade receipt; native startup cannot precede its backup. */
export class FileCommunityEnvironmentUpgrade implements CommunityEnvironmentUpgradeStorePort {
  private readonly root: string
  constructor(dataRoot: string, private readonly spaces: CommunityUserSpaceStoragePort) { this.root = resolve(dataRoot, 'environment-upgrades') }
  async inspect(username: string, spaceId: string): Promise<CommunityEnvironmentUpgradeState> {
    const home = await this.home(username, spaceId)
    const path = join(this.root, `${spaceId}.json`)
    try {
      assertOwnedDirectory(this.root)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('Invalid upgrade receipt ownership')
      const value = JSON.parse(await readFile(path, 'utf8')) as { version: unknown, spaceId: unknown, selectSharedModel: unknown }
      if (value.version !== '0.1.1' || value.spaceId !== spaceId || typeof value.selectSharedModel !== 'boolean') throw new Error('Invalid upgrade receipt')
      return { state: 'complete', selectSharedModel: value.selectSharedModel }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    // lstat never traverses a linked harness home. No member config is read here.
    try { await lstat(dshHomePath(home)); return { state: 'legacy' } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return { state: 'new' } }
  }
  async complete(username: string, spaceId: string, result: { selectSharedModel: boolean, backup?: CommunityEnvironmentBackup }): Promise<void> {
    await this.home(username, spaceId)
    try { await mkdir(this.root, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    assertOwnedDirectory(this.root)
    const path = join(this.root, `${spaceId}.json`); const staging = `${path}.tmp-${randomBytes(16).toString('hex')}`
    try {
      await writeFile(staging, JSON.stringify({ version: '0.1.1', spaceId, ...result }), { mode: 0o600, flag: 'wx', flush: true })
      await rename(staging, path)
    } finally { await rm(staging, { force: true }) }
  }
  private async home(username: string, spaceId: string): Promise<string> {
    if (!/^[a-f0-9]{32}$/u.test(spaceId)) throw new Error('Invalid user-space identity')
    const space = await this.spaces.prepare(username)
    if (space.spaceId !== spaceId) throw new Error('User-space identity changed')
    return space.home
  }
}
