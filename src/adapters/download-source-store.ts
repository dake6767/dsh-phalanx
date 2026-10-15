import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { downloadSourceSelection, type DownloadSourceSelection } from '../domain/download-source.js'
import type { DownloadSourceStorePort } from '../ports/download-sources.js'

/** The service owns the saved choice; upgrades read the same small configuration file. */
export class FileDownloadSources implements DownloadSourceStorePort {
  private selection: DownloadSourceSelection
  constructor(private readonly path: string, initial: DownloadSourceSelection = { preset: 'official' }) {
    if (existsSync(path)) {
      const file = lstatSync(path)
      if (!file.isFile() || file.size > 65_536) throw new Error('Saved download sources must be a bounded regular file')
    }
    this.selection = downloadSourceSelection(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : initial)
  }
  get(): DownloadSourceSelection { return structuredClone(this.selection) }
  save(input: DownloadSourceSelection): void {
    const value = downloadSourceSelection(input)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify(value)+'\n', { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.path); this.selection = value
    } finally { rmSync(temporary, { force: true }) }
  }
}
