import { BusinessRuleError } from '../domain/business-error.js'
import { downloadSourceSelection, type DownloadSourceSelection } from '../domain/download-source.js'
import type { DownloadSourceStorePort, SavedDownloadSourceSelection } from '../ports/download-sources.js'
import type { PlatformDatabase } from './platform-database.js'
import { PlatformStoreLifecycle } from './platform-store-lifecycle.js'

interface Row extends Record<string, unknown> {
  selection: unknown
  revision: string
}

/**
 * The deployment-wide download choice. Until an administrator saves, the choice the
 * installer recorded in the local configuration applies; once saved, the database
 * row does. The view is registered in architecture.md: synchronous preparation code
 * reads it, and it is refreshed only after each committed save.
 */
export class PostgresDownloadSources implements DownloadSourceStorePort {
  private view: { selection: DownloadSourceSelection; revision: number } | undefined
  private readonly lifecycle = new PlatformStoreLifecycle('Download source storage')
  constructor(
    private readonly database: PlatformDatabase,
    private readonly installed: DownloadSourceSelection,
  ) {}
  initialize(): Promise<void> {
    return this.lifecycle.initialize(() => this.load())
  }
  close(): Promise<void> {
    return this.lifecycle.close(() => (this.view = undefined))
  }
  get(): SavedDownloadSourceSelection {
    this.lifecycle.assertOpen()
    if (!this.view) throw Error('Download source storage is not ready')
    return { ...structuredClone(this.view.selection), saved: this.view.revision > 0 }
  }
  save(input: DownloadSourceSelection): Promise<void> {
    return this.lifecycle.write(async () => {
      const selection = downloadSourceSelection(input)
      this.get() // closed or not yet initialized is reported before any query
      const expected = this.view!.revision
      const [row] = await this.database.query<{ revision: string }>(
        `INSERT INTO dsh_phalanx.download_sources(id,selection,revision) VALUES(1,$1,1)
         ON CONFLICT(id) DO UPDATE SET selection=EXCLUDED.selection,revision=download_sources.revision+1 WHERE download_sources.revision=$2
         RETURNING revision`,
        [JSON.stringify(selection), expected],
      )
      // No row back: the stored revision moved past ours (including a concurrent first save).
      if (!row) throw new BusinessRuleError('conflict', 'Platform configuration changed. Reload before saving.', 'platform-configuration-conflict')
      this.view = { selection, revision: Number(row.revision) }
    })
  }
  private async load(): Promise<void> {
    const [row] = await this.database.query<Row>('SELECT selection,revision FROM dsh_phalanx.download_sources WHERE id=1')
    this.view = row
      ? { selection: downloadSourceSelection(row.selection), revision: Number(row.revision) }
      : { selection: downloadSourceSelection(this.installed), revision: 0 }
  }
}
