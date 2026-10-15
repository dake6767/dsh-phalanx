import type { DownloadSourceSelection, DownloadSourceValues } from '../domain/download-source.js'

export interface DownloadSourceStorePort {
  get(): DownloadSourceSelection
  save(value: DownloadSourceSelection): void
}
export interface DownloadSourceReaderPort { current(): DownloadSourceValues }
