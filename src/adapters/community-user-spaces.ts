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

  async existingHome(username: string, spaceId: string): Promise<string | undefined> {
    await this.assertAvailable()
    const space = await this.spaces.getSpace(username)
    if (space?.spaceId !== spaceId) return
    const directories = this.directories(space.storageKey)
    for (const path of directories) assertOwnedDirectory(path)
    return directories.at(-1)
  }

  private directories(storageKey: string): string[] {
    if (!/^(?:[a-z0-9][a-z0-9_-]{0,63}|_spaces\/[a-f0-9]{32})$/u.test(storageKey)) throw new Error('Invalid user space directory mapping')
    const paths = [this.root]
    for (const segment of storageKey.split('/')) paths.push(join(paths.at(-1)!, segment))
    paths.push(join(paths.at(-1)!, 'home'))
    return paths
  }

  async prepare(username: string) {
    await this.assertAvailable()
    const space = await this.spaces.getSpace(username)
    if (space === undefined) throw new Error('User space was not found')
    const paths = this.directories(space.storageKey)
    const home = paths.at(-1)!
    const workspace = join(paths.at(-2)!, 'workspace')
    for (const path of [...paths, workspace]) {
      await mkdir(path, { recursive: true, mode: 0o700 })
      assertOwnedDirectory(path)
    }
    return { home, workspace, spaceId: space.spaceId }
  }
}
