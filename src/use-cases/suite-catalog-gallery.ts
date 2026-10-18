import type { CommunitySuiteCatalogSourceView } from '../domain/admin-contract.js'
import { readSuiteCatalog, type ReadSuiteCatalogEntry } from '../domain/suite-catalog-reader.js'
import type { TrustedSuiteCatalogKey } from '../domain/suite-catalog-signature.js'
import { resolveSuiteCatalogAddress } from '../domain/suite-catalog-source.js'
import type { SuiteCatalogEntry } from '../domain/suite-catalog.js'
import { suiteCatalogAddress } from '../domain/community-config.js'
import type { SuiteInstallRecord } from '../domain/suite-install.js'
import type { DownloadSourceReaderPort } from '../ports/download-sources.js'
import type { SuiteCatalogFetchPort, SuiteInstallStorePort } from '../ports/suite-catalog.js'

export interface SuiteCatalogGalleryInput {
  /** Entries bundled with this platform version until tickets 06/07 move them online. */
  readonly builtin: readonly SuiteCatalogEntry[]
  /** Deployer address; undefined derives the default from the GitHub asset prefix. */
  readonly configuredAddress?: string
  readonly trustedKeys: readonly TrustedSuiteCatalogKey[]
  readonly platformVersion: string
  readonly downloads: DownloadSourceReaderPort
  readonly installs: Pick<SuiteInstallStorePort, 'read'>
  readonly fetcher: SuiteCatalogFetchPort
  /** Diagnostics sink; the composition root wires it to console.warn. */
  readonly log?: (line: string) => void
}

interface GalleryState {
  readonly entries: readonly SuiteCatalogEntry[]
  readonly source: CommunitySuiteCatalogSourceView
}

/**
 * Owns the online catalog for one gallery view. Every open or update check calls `load`; nothing is cached
 * across requests, and a failed fetch leaves only the bundled entries installable.
 */
export class SuiteCatalogGallery {
  private state: GalleryState
  private pending: Promise<CommunitySuiteCatalogSourceView> | undefined
  /** Deployer or test address, validated on the same path as the environment loader. */
  private readonly configuredAddress: string | undefined
  constructor(private readonly input: SuiteCatalogGalleryInput) {
    this.configuredAddress = input.configuredAddress === undefined ? undefined : suiteCatalogAddress(input.configuredAddress)
    this.state = { entries: [...input.builtin], source: { status: 'ok', address: this.address() } }
  }
  /** Address the next load uses, before the fetch. */
  address(): string { return resolveSuiteCatalogAddress(this.configuredAddress, this.input.downloads.current().githubAssets) }
  entries(): readonly SuiteCatalogEntry[] { return this.state.entries }
  source(): CommunitySuiteCatalogSourceView { return this.state.source }
  /**
   * Concurrent gallery opens without their own cancellation share one in-flight request. A caller that passes a
   * signal keeps a private request, so aborting it cannot poison the other waiters.
   */
  load(signal?: AbortSignal): Promise<CommunitySuiteCatalogSourceView> {
    if (signal !== undefined) return this.performLoad(signal)
    if (this.pending) return this.pending
    const pending = this.performLoad(new AbortController().signal).finally(() => { if (this.pending === pending) this.pending = undefined })
    this.pending = pending
    return pending
  }
  private async performLoad(signal: AbortSignal): Promise<CommunitySuiteCatalogSourceView> {
    const address = this.address()
    try {
      const bytes = await this.input.fetcher.read(address, signal)
      const read = readSuiteCatalog(bytes, { trustedKeys: this.input.trustedKeys, platformVersion: this.input.platformVersion })
      if (read.status === 'rejected') {
        this.state = { entries: [...this.input.builtin], source: { status: 'rejected', address, reason: read.reason } }
        return this.source()
      }
      if (read.skipped.length) this.input.log?.(`Suite catalog skipped unsupported entry kinds: ${read.skipped.map(row => `${row.kind}:${row.id}`).join(', ')}`)
      const records = this.input.installs.read().installs
      const online = read.entries.map(row => this.guardImmutability(row, records))
      const builtinIds = new Set(this.input.builtin.map(entry => entry.id))
      this.state = { entries: [...this.input.builtin, ...online.filter(entry => !builtinIds.has(entry.id))],
        source: { status: 'ok', address, publishedAt: read.publishedAt } }
    } catch (error) {
      this.state = { entries: [...this.input.builtin], source: { status: 'unreachable', address, reason: error instanceof Error ? error.message : 'The catalog request failed.' } }
    }
    return this.source()
  }
  /** Same id and version must keep its content: a different hash is treated as tampering. */
  private guardImmutability(row: ReadSuiteCatalogEntry, records: readonly SuiteInstallRecord[]): SuiteCatalogEntry {
    if (row.unavailableReason) return row.entry
    const installed = records.find(record => record.id === row.entry.id && record.version === row.entry.version)
    if (installed?.contentHash && installed.contentHash !== row.contentHash) return { ...row.entry, unavailableReason: 'content-tampered' }
    return row.entry
  }
}
