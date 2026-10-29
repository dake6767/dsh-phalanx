import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { SharedModelState } from '../domain/shared-models.js'
import type { PreparedSharedModels, SharedModelProjectionPort } from '../ports/shared-models.js'
import {
  managedModelCatalog,
  managedModelConfiguration,
  managedModelOverlay,
  managedModelsCatalog,
  managedModelsConfig,
  managedModelsDirectory,
  managedModelsContainerPath,
  managedModelsWatcher,
  managedModelWatchModule,
  managedModelPackages,
  managedModelContainerModules,
} from '../dsh/shared-models.js'

/** Stage the official runtime include, then switch its watched catalog last. No provider credential is projected. */
export class FileSharedModelProjection implements SharedModelProjectionPort {
  constructor(
    private readonly dataRoot: string,
    private readonly runtime?: CommunityRuntimeConfig,
  ) {}
  prepare(state: SharedModelState): PreparedSharedModels {
    const directory = join(this.dataRoot, managedModelsDirectory)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const mounted = this.runtime?.container ? managedModelsContainerPath : directory
    const pending: { temporary: string; target: string }[] = []
    const discard = () => {
      for (const file of pending) rmSync(file.temporary, { force: true })
      pending.length = 0
    }
    try {
      for (const [name, contents] of [
        [managedModelsWatcher, managedModelWatchModule],
        ['overlay.yml', managedModelOverlay(mounted)],
        [managedModelsConfig, managedModelConfiguration(state, mounted, this.modules())],
        [managedModelsCatalog, managedModelCatalog(state)],
      ]) {
        const target = join(directory, name!),
          temporary = target + '.tmp-' + randomBytes(16).toString('hex')
        const descriptor = openSync(temporary, 'wx', 0o600)
        pending.push({ temporary, target })
        try {
          writeFileSync(descriptor, contents!)
        } finally {
          closeSync(descriptor)
        }
      }
    } catch (error) {
      discard()
      throw error
    }
    return {
      discard,
      publish: () => {
        while (pending.length) {
          const file = pending[0]!
          renameSync(file.temporary, file.target)
          pending.shift()
        }
      },
    }
  }
  private modules(): { adapter: string } {
    if (this.runtime?.container) return managedModelContainerModules
    const command = this.runtime?.args[0] ?? this.runtime?.command
    if (!command || !existsSync(command)) return managedModelPackages
    const require = createRequire(resolve(command))
    try {
      return { adapter: require.resolve(managedModelPackages.adapter) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return managedModelPackages
      throw error
    }
  }
}
