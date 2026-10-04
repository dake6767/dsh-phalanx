import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { UserStorageGuard, assertOwnedDirectory } from './user-storage-guard.js'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CommunityUserSpaceReaderPort, CommunityUserSpaceStoragePort } from '../ports/community-user-spaces.js'

/** Resolves only durable account-owned directories, preserving retired spaces. */
export class FileCommunityUserSpaces implements CommunityUserSpaceStoragePort {
  private readonly root: string
  private readonly guard: UserStorageGuard
  constructor(config: Pick<CommunityRuntimeConfig, 'dataRoot' | 'userDataRoot' | 'userDataMount' | 'container'>, private readonly spaces: CommunityUserSpaceReaderPort) {
    this.root = resolve(config.userDataRoot ?? join(config.dataRoot, 'users'))
    this.guard = new UserStorageGuard(config.dataRoot, config.userDataRoot, config.container !== undefined, config.userDataMount)
  }

  assertAvailable(): void { this.guard.assertAvailable() }

  async prepare(username: string) {
    this.assertAvailable()
    const space = this.spaces.getSpace(username)
    if (space === undefined) throw new Error('User space was not found')
    if (!/^(?:[a-z0-9][a-z0-9_-]{0,63}|_spaces\/[a-f0-9]{32})$/u.test(space.storageKey)) throw new Error('Invalid user space directory mapping')
    const root = join(this.root, space.storageKey)
    const home = join(root, 'home'); const workspace = join(root, 'workspace')
    await mkdir(this.root, { recursive: true, mode: 0o700 }); assertOwnedDirectory(this.root)
    let parent = this.root
    for (const segment of space.storageKey.split('/')) {
      parent = join(parent, segment); await mkdir(parent, { recursive: true, mode: 0o700 }); assertOwnedDirectory(parent)
    }
    for (const path of [home, workspace]) { await mkdir(path, { recursive: true, mode: 0o700 }); assertOwnedDirectory(path) }
    return { home, workspace, spaceId: space.spaceId }
  }
}
