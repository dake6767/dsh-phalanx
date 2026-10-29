import type { DownloadSourceSelection, DownloadSourceValues } from '../domain/download-source.js'

/** The effective selection, and whether an administrator saved it (otherwise the installed choice applies). */
export type SavedDownloadSourceSelection = DownloadSourceSelection & { readonly saved: boolean }

export interface DownloadSourceStorePort {
  get(): SavedDownloadSourceSelection
  save(value: DownloadSourceSelection): Promise<void>
}
export interface DownloadSourceReaderPort {
  current(): DownloadSourceValues
}
