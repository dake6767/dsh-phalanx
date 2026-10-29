import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { assertOwnedDirectory } from './user-storage-files.js'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { effectiveUserDataRoot } from '../domain/storage-layout.js'
import type { CommunityUserSpaceReaderPort, CommunityUserSpaceStoragePort } from '../ports/community-user-spaces.js'

/** Resolves only durable account-owned directories, preserving retired spaces. */
export class FileCommunityUserSpaces implements CommunityUserSpaceStoragePort {
  readonly root: string
  constructor(
    config: Pick<CommunityRuntimeConfig, 'dataRoot' | 'userDataRoot' | 'userDataMount' | 'container'>,
    private readonly spaces: CommunityUserSpaceReaderPort,
    private readonly guard: Pick<CommunityUserSpaceStoragePort, 'assertAvailable'>,
  ) {
    this.root = effectiveUserDataRoot(config)
  }

  async assertAvailable(): Promise<void> {
    await this.guard.assertAvailable()
  }

  async prepare(username: string) {
    await this.assertAvailable()
    const space = await this.spaces.getSpace(username)
    if (space === undefined) throw new Error('User space was not found')
    if (!/^(?:[a-z0-9][a-z0-9_-]{0,63}|_spaces\/[a-f0-9]{32})$/u.test(space.storageKey)) throw new Error('Invalid user space directory mapping')
    const root = join(this.root, space.storageKey)
    const home = join(root, 'home')
    const workspace = join(root, 'workspace')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    assertOwnedDirectory(this.root)
    let parent = this.root
    for (const segment of space.storageKey.split('/')) {
      parent = join(parent, segment)
      await mkdir(parent, { recursive: true, mode: 0o700 })
      assertOwnedDirectory(parent)
    }
    for (const path of [home, workspace]) {
      await mkdir(path, { recursive: true, mode: 0o700 })
      assertOwnedDirectory(path)
    }
    return { home, workspace, spaceId: space.spaceId }
  }
}
