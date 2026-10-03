import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CommunityAccountRecord, CommunityAccountState, CommunityCreateAccountInput } from '../domain/community-account.js'
import { assertCommunityAdminChange, validatedCommunityAccountInput, validateCommunityPassword } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { hashPassword, verifyPassword } from '../domain/password.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'

interface AccountRow {
  username: string, email: string, password_hash: string, admin: number,
  disabled: number, session_epoch: number, created_at: number, updated_at: number
}

/** Community schema only. No migration or reinterpretation of a legacy account database. */
export class CommunityAccountStore implements CommunityAccountStorePort {
  private readonly db: DatabaseSync
  private readonly dummyHash = hashPassword(randomBytes(32).toString('base64url'))
  private closed = false

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;')
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version
      if (version === 0) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").get() !== undefined) {
          throw new Error('community accounts require a fresh database')
        }
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE accounts (
            username TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
            password_hash TEXT NOT NULL, admin INTEGER NOT NULL CHECK (admin IN (0, 1)),
            disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
            session_epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE TABLE bootstrap_state (id INTEGER PRIMARY KEY CHECK (id = 1), completed INTEGER NOT NULL);
          INSERT INTO bootstrap_state VALUES (1, 0);
          PRAGMA user_version = 1;
          COMMIT;`)
      } else if (version !== 1 && version !== 2) throw new Error('unsupported community account schema')
      if (version !== 2) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE retired_accounts (username TEXT PRIMARY KEY, retired_at INTEGER NOT NULL);
        PRAGMA user_version = 2;
        COMMIT;`)
    } catch (error) { this.db.close(); throw error }
  }

  get(username: string): CommunityAccountRecord | undefined {
    const row = this.row(username)
    return row === undefined ? undefined : publicRecord(row)
  }
  getState(username: string): CommunityAccountState | undefined {
    const row = this.row(username)
    return row === undefined ? undefined : { username: row.username, disabled: row.disabled === 1, sessionEpoch: row.session_epoch }
  }
  list(): readonly CommunityAccountRecord[] {
    return (this.db.prepare('SELECT * FROM accounts ORDER BY username').all() as unknown as AccountRow[]).map(publicRecord)
  }
  bootstrapComplete(): boolean { return this.db.prepare('SELECT completed FROM bootstrap_state WHERE id = 1').get()?.completed === 1 }

  async create(input: CommunityCreateAccountInput): Promise<CommunityAccountRecord> { return await this.insert(input, false) }
  async createFirstAdmin(input: CommunityCreateAccountInput): Promise<CommunityAccountRecord> { return await this.insert(input, true) }
  async authenticate(username: string, password: string): Promise<CommunityAccountRecord | undefined> {
    const row = this.row(username)
    const valid = await verifyPassword(password, row?.password_hash ?? await this.dummyHash)
    const current = this.row(username)
    return valid && row !== undefined && current?.password_hash === row.password_hash && current.disabled === 0
      ? publicRecord(current) : undefined
  }
  async resetPassword(username: string, password: string): Promise<void> {
    validateCommunityPassword(password)
    const digest = await hashPassword(password)
    this.transaction(() => {
      this.required(username)
      this.db.prepare('UPDATE accounts SET password_hash = ?, session_epoch = session_epoch + 1, updated_at = ? WHERE username = ?')
        .run(digest, Date.now(), username)
    })
  }
  async setDisabled(username: string, disabled: boolean): Promise<CommunityAccountRecord> {
    return this.transaction(() => {
      const current = this.required(username)
      assertCommunityAdminChange(current, { admin: current.admin, disabled }, this.enabledAdmins())
      if (current.disabled !== disabled) this.db.prepare('UPDATE accounts SET disabled = ?, session_epoch = session_epoch + ?, updated_at = ? WHERE username = ?')
        .run(disabled ? 1 : 0, disabled ? 1 : 0, Date.now(), username)
      return this.get(username)!
    })
  }
  async setAdmin(username: string, admin: boolean): Promise<CommunityAccountRecord> {
    return this.transaction(() => {
      const current = this.required(username)
      assertCommunityAdminChange(current, { admin, disabled: current.disabled }, this.enabledAdmins())
      this.db.prepare('UPDATE accounts SET admin = ?, updated_at = ? WHERE username = ?').run(admin ? 1 : 0, Date.now(), username)
      return this.get(username)!
    })
  }
  async delete(username: string): Promise<void> {
    this.transaction(() => {
      const current = this.required(username)
      assertCommunityAdminChange(current, undefined, this.enabledAdmins())
      this.db.prepare('INSERT INTO retired_accounts (username, retired_at) VALUES (?, ?)').run(username, Date.now())
      this.db.prepare('DELETE FROM accounts WHERE username = ?').run(username)
    })
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true } }

  private required(username: string): CommunityAccountRecord {
    const account = this.get(username)
    if (account === undefined) throw new BusinessRuleError('missing', 'Account was not found')
    return account
  }
  private enabledAdmins(): number { return Number(this.db.prepare('SELECT count(*) AS total FROM accounts WHERE admin = 1 AND disabled = 0').get()!.total) }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private row(username: string): AccountRow | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE username = ?').get(username) as unknown as AccountRow | undefined
  }
  private async insert(input: CommunityCreateAccountInput, admin: boolean): Promise<CommunityAccountRecord> {
    const { email } = validatedCommunityAccountInput(input)
    const digest = await hashPassword(input.password)
    return this.transaction(() => {
      if (admin && this.bootstrapComplete()) throw new BusinessRuleError('conflict', 'Bootstrap is already complete')
      if (this.row(input.username) !== undefined) throw new BusinessRuleError('conflict', 'Username is already in use')
      if (this.db.prepare('SELECT 1 FROM retired_accounts WHERE username = ?').get(input.username) !== undefined) {
        throw new BusinessRuleError('conflict', 'Username is reserved by a deleted account; choose a different username')
      }
      if (this.db.prepare('SELECT 1 FROM accounts WHERE email = ?').get(email) !== undefined) throw new BusinessRuleError('conflict', 'Email is already in use')
      const now = Date.now()
      this.db.prepare('INSERT INTO accounts (username, email, password_hash, admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.username, email, digest, admin ? 1 : 0, now, now)
      if (admin) this.db.exec('UPDATE bootstrap_state SET completed = 1 WHERE id = 1')
      return this.get(input.username)!
    })
  }
}

function publicRecord(row: AccountRow): CommunityAccountRecord {
  return { username: row.username, email: row.email, admin: row.admin === 1,
    disabled: row.disabled === 1, sessionEpoch: row.session_epoch, createdAt: row.created_at, updatedAt: row.updated_at }
}
