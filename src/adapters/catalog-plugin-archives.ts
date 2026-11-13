import { PluginPreparationError } from '../domain/plugin-library.js'
import { readCatalogPluginArchive } from '../domain/suite-plugin.js'
import type { CatalogPluginArchivePort, PluginUploadPort } from '../ports/plugin-library.js'
import type { HttpGithubPluginSource } from './github-plugin-source.js'

/** Release assets enter the same bounded, isolated upload and preparation path as local archives. */
export class CatalogPluginArchives implements CatalogPluginArchivePort {
  constructor(
    private readonly source: Pick<HttpGithubPluginSource, 'releaseAsset'>,
    private readonly uploads: PluginUploadPort,
  ) {}
  async load(url: string, integrity: string, signal: AbortSignal) {
    if (!readCatalogPluginArchive({ url })) throw new PluginPreparationError('plugin-package-invalid')
    const download = new AbortController()
    try {
      const body = await this.source.releaseAsset(url, AbortSignal.any([signal, download.signal]))
      return await this.uploads.accept('catalog-plugin.tgz', body, signal, integrity)
    } finally {
      download.abort()
    }
  }
  discard(archive: string): Promise<void> {
    return this.uploads.discard(archive)
  }
}
