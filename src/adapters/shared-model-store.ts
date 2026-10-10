import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SharedModelState } from '../domain/shared-models.js'
import type { SharedModelStorePort } from '../ports/shared-models.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { managedModelCatalog, managedModelConfiguration, managedModelOverlay, managedModelsCatalog, managedModelsConfig, managedModelsDirectory, managedModelsContainerPath, managedModelsWatcher, managedModelWatchModule, managedModelPackages, managedModelContainerModules } from '../dsh/shared-models.js'
import type { CommunityConfig } from '../domain/community-config.js'

/** Import the actual old deployment once; persisted administrator edits always win. */
export function initialSharedModelState(config: CommunityConfig): SharedModelState {
  if (config.modelGateway === undefined) return { revision: 0, providers: [], defaultModelId: null }
  return { revision: 0, providers: [{ id: 'legacy-deepseek', name: 'DeepSeek', apiFormat: 'anthropic-messages',
    baseUrl: `${config.runtime.defaultModel.upstream.baseUrl.replace(/\/+$/u, '')}/anthropic`, apiKey: config.modelGateway.upstreamApiKey,
    enabled: true, models: [{ id: config.runtime.defaultModel.model, name: config.runtime.defaultModel.model, enabled: true }] }], defaultModelId: config.runtime.defaultModel.model }
}

/** Atomic private file; the platform lock provides exclusive process ownership. */
export class FileSharedModelStore implements SharedModelStorePort {
  private state: SharedModelState
  constructor(private readonly path: string, initial: SharedModelState, private readonly runtime?: CommunityRuntimeConfig) {
    this.state = initial
    if (existsSync(path)) {
      try {
        this.state = JSON.parse(readFileSync(path, 'utf8')) as SharedModelState
        if (!Number.isSafeInteger(this.state.revision) || !Array.isArray(this.state.providers)) throw new Error('Invalid configuration')
        chmodSync(path, 0o600)
      } catch { throw new Error('Shared model storage could not be loaded') }
    } else this.write(initial)
    this.publish(this.state, true)
  }
  read(): SharedModelState { return this.state }
  newId(): string { return randomBytes(16).toString('hex') }
  save(state: SharedModelState): void {
    if (state.revision !== this.state.revision + 1) throw new BusinessRuleError('conflict', 'Model settings changed. Reload before saving.', 'model-revision-conflict', { expectedRevision: this.state.revision, receivedRevision: state.revision - 1 })
    try { this.publish(state); this.write(state) }
    catch (error) { this.publish(this.state); throw error }
    this.state = state
  }
  private publish(state: SharedModelState, initialize = false): void {
    const directory = join(dirname(this.path), managedModelsDirectory)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (initialize || !existsSync(join(directory, managedModelsWatcher))) this.atomic(join(directory, managedModelsWatcher), managedModelWatchModule)
    const mounted = this.runtime?.container !== undefined ? managedModelsContainerPath : directory
    if (initialize || !existsSync(join(directory, 'overlay.yml'))) this.atomic(join(directory, 'overlay.yml'), managedModelOverlay(mounted))
    this.atomic(join(directory, managedModelsConfig), managedModelConfiguration(state, mounted, this.modules()))
    this.atomic(join(directory, managedModelsCatalog), managedModelCatalog(state))
  }
  private modules(): { adapter: string } {
    const packages = managedModelPackages
    if (this.runtime?.container !== undefined) return managedModelContainerModules
    const command = this.runtime?.args[0] ?? this.runtime?.command
    if (command === undefined || !existsSync(command)) return packages
    const require = createRequire(resolve(command))
    try { return { adapter: require.resolve(packages.adapter) } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return packages; throw error }
  }
  private write(state: SharedModelState): void {
    this.atomic(this.path, JSON.stringify(state))
  }
  private atomic(path: string, contents: string): void {
    const staging = `${path}.tmp-${this.newId()}`
    try { writeFileSync(staging, contents, { mode: 0o600, flag: 'wx' }); renameSync(staging, path) }
    finally { rmSync(staging, { force: true }) }
  }
}
