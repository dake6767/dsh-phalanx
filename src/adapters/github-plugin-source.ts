import { open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertGithubRepository, PluginPreparationError, pluginSourceAbortCode, PLUGIN_SOURCE_ARCHIVE_MAX_BYTES } from '../domain/plugin-library.js'
import type { DownloadSourceReaderPort } from '../ports/download-sources.js'
import type { GithubPluginRevision, GithubPluginSourcePort } from '../ports/plugin-source.js'

const apiOrigin = 'https://api.github.com'
const COMMITS_MAX_BYTES = 4 * 1024 * 1024

/** Reads at most limit bytes and cancels the transfer beyond it. */
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) throw new PluginPreparationError('plugin-github-unavailable')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks)
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new PluginPreparationError('plugin-github-unavailable')
    }
    chunks.push(value)
  }
}
const archiveOrigin = 'https://github.com'

/**
 * GitHub access follows the two configured download prefixes: the API prefix resolves the commit and
 * the asset prefix fetches its archive. Each prefix is used as given, followed by the full upstream URL.
 */
export class HttpGithubPluginSource implements GithubPluginSourcePort {
  constructor(
    private readonly downloads: DownloadSourceReaderPort,
    private readonly origins: { readonly api: string; readonly archive: string } = { api: apiOrigin, archive: archiveOrigin },
  ) {}
  async resolve(repository: string, signal: AbortSignal): Promise<GithubPluginRevision> {
    assertGithubRepository(repository)
    const response = await this.fetch(
      this.downloads.current().githubApi + `${this.origins.api}/repos/${repository}/commits?per_page=1`,
      { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      signal,
      15_000,
    )
    if (response.status === 404 || response.status === 409) {
      await response.body?.cancel()
      // 409 is an empty repository: it has no default-branch commit to pin.
      throw new PluginPreparationError('plugin-github-repository-missing')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new PluginPreparationError('plugin-github-unavailable')
    }
    let commits: unknown
    try {
      commits = JSON.parse((await boundedBody(response, COMMITS_MAX_BYTES)).toString('utf8'))
    } catch (cause) {
      if (cause instanceof PluginPreparationError) throw cause
      throw new PluginPreparationError(signal.aborted ? pluginSourceAbortCode(signal, 'plugin-github-unavailable') : 'plugin-github-unavailable', { cause })
    }
    const commit = Array.isArray(commits) ? (commits[0] as { sha?: unknown } | undefined)?.sha : undefined
    if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/u.test(commit)) throw new PluginPreparationError('plugin-github-unavailable')
    return { repository, commit }
  }
  async download(revision: GithubPluginRevision, directory: string, signal: AbortSignal): Promise<string> {
    assertGithubRepository(revision.repository)
    if (!/^[a-f0-9]{40}$/u.test(revision.commit)) throw new PluginPreparationError('plugin-package-invalid')
    const response = await this.fetch(
      this.downloads.current().githubAssets + `${this.origins.archive}/${revision.repository}/archive/${revision.commit}.tar.gz`,
      { accept: 'application/gzip, application/octet-stream' },
      signal,
      300_000,
    )
    // The commit already resolved, so a missing archive is a proxy or transfer failure, not a missing repository.
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new PluginPreparationError('plugin-github-unavailable')
    }
    const path = join(directory, `${randomUUID()}.tar.gz`)
    const file = await open(path, 'wx', 0o600)
    let complete = false
    try {
      let size = 0
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength
        if (size > PLUGIN_SOURCE_ARCHIVE_MAX_BYTES) throw new PluginPreparationError('plugin-package-invalid')
        let offset = 0
        while (offset < chunk.byteLength) offset += (await file.write(chunk, offset, chunk.byteLength - offset)).bytesWritten
      }
      if (size === 0) throw new PluginPreparationError('plugin-github-unavailable')
      complete = true
      return path
    } catch (error) {
      if (error instanceof PluginPreparationError) throw error
      throw new PluginPreparationError(signal.aborted ? pluginSourceAbortCode(signal, 'plugin-github-unavailable') : 'plugin-github-unavailable', {
        cause: error,
      })
    } finally {
      await file.close()
      if (!complete) await rm(path, { force: true })
    }
  }
  async releaseAsset(url: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const response = await this.fetch(this.downloads.current().githubAssets + url, { accept: 'application/octet-stream' }, signal, 300_000)
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new PluginPreparationError('plugin-github-unavailable')
    }
    const body = response.body as AsyncIterable<Uint8Array>
    return {
      async *[Symbol.asyncIterator]() {
        try {
          yield* body
        } catch (cause) {
          throw new PluginPreparationError(signal.aborted ? pluginSourceAbortCode(signal, 'plugin-github-unavailable') : 'plugin-github-unavailable', {
            cause,
          })
        }
      },
    }
  }
  /**
   * Proxies and GitHub redirect archives to codeload or a CDN. Each hop is followed manually and must stay on HTTPS,
   * unless the configured address itself is plain HTTP (a local mirror); credentials are never sent.
   */
  private async fetch(url: string, headers: Record<string, string>, signal: AbortSignal, timeout: number): Promise<Response> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    const plain = new URL(url).protocol === 'http:'
    let next = new URL(url)
    try {
      for (let hop = 0; ; hop++) {
        if ((next.protocol !== 'https:' && !(plain && next.protocol === 'http:')) || next.username || next.password)
          throw new PluginPreparationError('plugin-github-unavailable')
        const response = await fetch(next, { headers, signal: deadline, redirect: 'manual', credentials: 'omit' })
        const location = response.headers.get('location')
        if (![301, 302, 303, 307, 308].includes(response.status)) return response
        await response.body?.cancel()
        if (hop === 5 || !location) throw new PluginPreparationError('plugin-github-unavailable')
        next = new URL(location, next)
      }
    } catch (cause) {
      if (cause instanceof PluginPreparationError) throw cause
      throw new PluginPreparationError(signal.aborted ? pluginSourceAbortCode(signal, 'plugin-github-unavailable') : 'plugin-github-unavailable', { cause })
    }
  }
}
