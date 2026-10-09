import { assertCommunityGroupRole, assertGroupDeletion, assertOrdinaryGroup, requiredCommunityGroup, validatedGroupName } from '../domain/community-group.js'
import type { CommunityGroupRecord } from '../domain/community-group.js'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CommunityAccountRecord, CommunityAccountState, CommunityCreateAccountInput } from '../domain/community-account.js'
import { assertCommunityAdminChange, validatedCommunityAccountInput, validatedCommunityEmail, validateCommunityPassword } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { hashPassword, verifyPassword } from '../domain/password.js'
import type { CommunityUserSpaceReaderPort, CommunityUserSpaceRecord } from '../ports/community-user-spaces.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'

interface AccountRow {
  username: string, group_id: string, space_id: string, storage_key: string, email: string | null, password_hash: string, admin: number,
  disabled: number, session_epoch: number, created_at: number, updated_at: number
}

/** Owns community account migrations; unrelated legacy databases remain unsupported. */
export class CommunityAccountStore implements CommunityAccountStorePort, CommunityUserSpaceReaderPort {
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
      } else if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) throw new Error('unsupported community account schema')
      if (version !== 2 && version !== 3 && version !== 4 && version !== 5) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE retired_accounts (username TEXT PRIMARY KEY, retired_at INTEGER NOT NULL);
        PRAGMA user_version = 2;
        COMMIT;`)
      if (version !== 3 && version !== 4 && version !== 5) this.transaction(() => {
        this.db.exec('ALTER TABLE accounts ADD COLUMN space_id TEXT; ALTER TABLE accounts ADD COLUMN storage_key TEXT;')
        for (const row of this.db.prepare('SELECT username FROM accounts').all()) {
          this.db.prepare('UPDATE accounts SET space_id = ?, storage_key = ? WHERE username = ?').run(randomBytes(16).toString('hex'), String(row.username), String(row.username))
        }
        this.db.exec('CREATE UNIQUE INDEX account_space_id ON accounts(space_id); PRAGMA user_version = 3;')
      })
      if (version !== 4 && version !== 5) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE accounts_optional_email (
          username TEXT PRIMARY KEY, email TEXT COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL, admin INTEGER NOT NULL CHECK (admin IN (0, 1)),
          disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
          session_epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          space_id TEXT NOT NULL UNIQUE, storage_key TEXT NOT NULL
        );
        INSERT INTO accounts_optional_email SELECT username, email, password_hash, admin, disabled,
          session_epoch, created_at, updated_at, space_id, storage_key FROM accounts;
        DROP TABLE accounts;
        ALTER TABLE accounts_optional_email RENAME TO accounts;
        PRAGMA user_version = 4;
        COMMIT;`)
      if (version !== 5) this.transaction(() => {
        this.db.exec(`CREATE TABLE groups (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('ordinary', 'admin')),
          is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)), CHECK(kind != 'admin' OR is_default = 0)
        );
        CREATE UNIQUE INDEX one_default_group ON groups(is_default) WHERE is_default = 1;
        CREATE UNIQUE INDEX one_admin_group ON groups(kind) WHERE kind = 'admin';
        INSERT INTO groups VALUES ('default', 'Default group', 'ordinary', 1), ('admin', 'Administrators', 'admin', 0);
        CREATE TABLE grouped_accounts (
          username TEXT PRIMARY KEY, email TEXT COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL,
          admin INTEGER NOT NULL CHECK(admin IN (0, 1)), disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0, 1)),
          session_epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          space_id TEXT NOT NULL UNIQUE, storage_key TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES groups(id)
        );
        INSERT INTO grouped_accounts SELECT username, email, password_hash, admin, disabled, session_epoch, created_at, updated_at,
          space_id, storage_key, CASE WHEN admin = 1 THEN 'admin' ELSE 'default' END FROM accounts;
        DROP TABLE accounts;
        ALTER TABLE grouped_accounts RENAME TO accounts;
        PRAGMA user_version = 5;`)
      })
      this.db.exec('PRAGMA foreign_keys = ON;')
    } catch (error) { this.db.close(); throw error }
  }

  listGroups(): readonly CommunityGroupRecord[] {
    const rows = this.db.prepare(`SELECT g.*, count(a.username) AS member_count FROM groups g
      LEFT JOIN accounts a ON a.group_id = g.id GROUP BY g.id ORDER BY g.name, g.id`).all()
    return rows.map(row => ({ id: String(row.id), name: String(row.name), kind: row.kind as 'ordinary' | 'admin',
      isDefault: row.is_default === 1, memberCount: Number(row.member_count) }))
  }
  createGroup(name: string): CommunityGroupRecord {
    return this.transaction(() => {
      const value = this.groupName(name)
      const id = randomBytes(16).toString('hex')
      this.db.prepare("INSERT INTO groups(id, name, kind) VALUES (?, ?, 'ordinary')").run(id, value)
      return this.requiredGroup(id)
    })
  }
  renameGroup(id: string, name: string): CommunityGroupRecord {
    return this.transaction(() => {
      this.requiredGroup(id)
      this.db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(this.groupName(name, id), id)
      return this.requiredGroup(id)
    })
  }
  deleteGroup(id: string): void {
    this.transaction(() => {
      const group = this.requiredGroup(id)
      assertGroupDeletion(group)
      this.db.prepare('DELETE FROM groups WHERE id = ?').run(id)
    })
  }
  setDefaultGroup(id: string): void {
    this.transaction(() => {
      assertOrdinaryGroup(this.requiredGroup(id))
      this.db.exec('UPDATE groups SET is_default = 0 WHERE is_default = 1')
      this.db.prepare('UPDATE groups SET is_default = 1 WHERE id = ?').run(id)
    })
  }
  private requiredGroup(id: string): CommunityGroupRecord {
    return requiredCommunityGroup(this.listGroups(), id)
  }
  private assertGroupRole(id: string, admin: boolean): void {
    assertCommunityGroupRole(this.requiredGroup(id), admin)
  }
  private groupName(name: string, except?: string): string {
    return validatedGroupName(this.listGroups(), name, except)
  }

  getSpace(username: string): CommunityUserSpaceRecord | undefined {
    const row = this.row(username)
    return row === undefined ? undefined : { spaceId: row.space_id, storageKey: row.storage_key }
  }

  get(username: string): CommunityAccountRecord | undefined {
    const row = this.row(username)
    return row === undefined ? undefined : publicRecord(row)
  }
  getState(username: string): CommunityAccountState | undefined {
    const row = this.row(username)
    return row === undefined ? undefined : { username: row.username, spaceId: row.space_id, disabled: row.disabled === 1, sessionEpoch: row.session_epoch }
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
  async setAccountDetails(username: string, email: string, groupId?: string): Promise<CommunityAccountRecord> {
    return this.transaction(() => {
      const current = this.required(username)
      const value = email.trim() === '' && current.email === '' ? null : validatedCommunityEmail(email)
      const targetGroup = groupId ?? current.groupId
      this.assertGroupRole(targetGroup, current.admin)
      if (this.db.prepare('SELECT 1 FROM accounts WHERE email = ? AND username != ?').get(value, username) !== undefined)
        throw new BusinessRuleError('conflict', 'Email is already in use', 'email-in-use')
      this.db.prepare('UPDATE accounts SET email = ?, group_id = ?, updated_at = ? WHERE username = ?').run(value, targetGroup, Date.now(), username)
      return this.get(username)!
    })
  }
  async setAdmin(username: string, admin: boolean, targetGroupId?: string): Promise<CommunityAccountRecord> {
    return this.transaction(() => {
      const current = this.required(username)
      assertCommunityAdminChange(current, { admin, disabled: current.disabled }, this.enabledAdmins())
      if (!admin && targetGroupId === undefined) throw new BusinessRuleError('invalid', 'Select a target group', 'group-required')
      const groupId = admin ? 'admin' : targetGroupId!
      this.assertGroupRole(groupId, admin)
      this.db.prepare('UPDATE accounts SET admin = ?, group_id = ?, updated_at = ? WHERE username = ?').run(admin ? 1 : 0, groupId, Date.now(), username)
      return this.get(username)!
    })
  }
  async delete(username: string): Promise<void> {
    this.transaction(() => {
      const current = this.required(username)
      assertCommunityAdminChange(current, undefined, this.enabledAdmins())
      this.db.prepare('INSERT OR REPLACE INTO retired_accounts (username, retired_at) VALUES (?, ?)').run(username, Date.now())
      this.db.prepare('DELETE FROM accounts WHERE username = ?').run(username)
    })
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true } }

  private required(username: string): CommunityAccountRecord {
    const account = this.get(username)
    if (account === undefined) throw new BusinessRuleError('missing', 'Account was not found', 'account-not-found')
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
      if (admin && this.bootstrapComplete()) throw new BusinessRuleError('conflict', 'Bootstrap is already complete', 'bootstrap-complete')
      if (this.row(input.username) !== undefined) throw new BusinessRuleError('conflict', 'Username is already in use', 'username-in-use')
      if (this.db.prepare('SELECT 1 FROM accounts WHERE email = ?').get(email) !== undefined) throw new BusinessRuleError('conflict', 'Email is already in use', 'email-in-use')
      const spaceId = randomBytes(16).toString('hex')
      const retired = this.db.prepare('SELECT 1 FROM retired_accounts WHERE username = ?').get(input.username) !== undefined
      const storageKey = retired ? `_spaces/${spaceId}` : input.username
      const now = Date.now()
      const groupId = admin ? 'admin' : input.groupId ?? String(this.db.prepare('SELECT id FROM groups WHERE is_default = 1').get()!.id)
      this.assertGroupRole(groupId, admin)
      this.db.prepare('INSERT INTO accounts (username, space_id, storage_key, email, password_hash, admin, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.username, spaceId, storageKey, email === '' ? null : email, digest, admin ? 1 : 0, groupId, now, now)
      if (admin) this.db.exec('UPDATE bootstrap_state SET completed = 1 WHERE id = 1')
      return this.get(input.username)!
    })
  }
}

function publicRecord(row: AccountRow): CommunityAccountRecord {
  return { username: row.username, spaceId: row.space_id, groupId: row.group_id, email: row.email ?? '', admin: row.admin === 1,
    disabled: row.disabled === 1, sessionEpoch: row.session_epoch, createdAt: row.created_at, updatedAt: row.updated_at }
}
