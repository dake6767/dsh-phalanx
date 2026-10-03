import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class PlatformMaintenanceBusyError extends Error {
  constructor() { super('another platform process already owns this data root') }
}

/** SQLite's exclusive OS lock is released on close and process death. */
export class PlatformLock {
  private readonly db: DatabaseSync
  private closed = false
  constructor(dataRoot: string) {
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(dataRoot, 'platform-lock.db'))
    try {
      this.db.exec('PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS platform_lock (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;')
    } catch (error) {
      this.db.close()
      const code = (error as { errcode?: number }).errcode
      if (code === 5 || code === 6) throw new PlatformMaintenanceBusyError()
      throw error
    }
  }
  close(): void {
    if (this.closed) return
    this.db.exec('ROLLBACK'); this.db.close(); this.closed = true
  }
}
