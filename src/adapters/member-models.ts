import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PlatformLocale } from '../domain/platform-language.js'
import type { SharedModelState } from '../domain/shared-models.js'
import { managedModelsCatalog, managedModelsContainerPath, managedModelsDirectory } from '../dsh/shared-models.js'
import { FileSharedModelProjection } from './shared-model-projection.js'

const languageFile = 'language.json'

/**
 * Owns one derived projection directory per member space. Entering a browser records its platform
 * language for that space and rederives the files; every published shared model change is fanned
 * out to the existing directories in each space's own language. The recorded language is a
 * projection input persisted beside its files, never a queryable business fact.
 */
export class MemberModelsProjection {
  constructor(
    private readonly dataRoot: string,
    private readonly readState: () => SharedModelState,
    private readonly runtime?: ConstructorParameters<typeof FileSharedModelProjection>[1],
  ) {}
  /** Record the entering browser language and rederive that space's projection when it changed. */
  enter(spaceId: string, locale: PlatformLocale): void {
    this.project(spaceId, locale)
  }
  /** The language a space last entered with; a directory without the record derives in English. */
  language(spaceId: string): PlatformLocale {
    const file = join(this.directory(spaceId), languageFile)
    if (!existsSync(file)) return 'en'
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as string
      return value === 'zh-CN' ? 'zh-CN' : 'en'
    } catch {
      return 'en'
    }
  }
  /** Derive the projection for a space that has not entered yet, keeping a complete existing directory unchanged. */
  ensure(spaceId: string): void {
    if (existsSync(join(this.directory(spaceId), managedModelsCatalog))) return
    this.project(spaceId, this.language(spaceId))
  }
  /** Rederive every existing space directory in its own language after a shared model change. */
  publish(state: SharedModelState): void {
    const members = join(this.dataRoot, managedModelsDirectory, 'members')
    if (!existsSync(members)) return
    for (const spaceId of readdirSync(members)) this.project(spaceId, this.language(spaceId), state)
  }
  /** The host patch and read-only container volume of one space's projection. */
  mount(spaceId: string): { patch: string; volumes: readonly { host: string; mounted: string }[] } {
    const directory = this.directory(spaceId)
    return { patch: join(directory, 'overlay.yml'), volumes: [{ host: directory, mounted: managedModelsContainerPath }] }
  }
  private directory(spaceId: string): string {
    return join(this.dataRoot, managedModelsDirectory, 'members', spaceId)
  }
  private project(spaceId: string, locale: PlatformLocale, state?: SharedModelState): void {
    const directory = this.directory(spaceId)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const previous = this.language(spaceId)
    writeFileSync(join(directory, languageFile), JSON.stringify(locale) + '\n', { encoding: 'utf8', mode: 0o600 })
    if (state === undefined && previous === locale && existsSync(join(directory, 'catalog.json'))) return
    const source = state ?? this.readState()
    new FileSharedModelProjection(this.dataRoot, this.runtime, directory, () => locale).prepare(source).publish()
  }
}
