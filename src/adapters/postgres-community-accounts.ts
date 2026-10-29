import { publicRecord, type AccountRow } from './postgres-community-account-record.js'
import { randomBytes } from 'node:crypto'
import type { PlatformDatabase, PlatformSql } from './platform-database.js'
import type { CommunityAccountRecord, CommunityAccountState, CommunityCreateAccountInput } from '../domain/community-account.js'
import { assertCommunityAdminChange, validateCommunityPassword, validatedCommunityAccountInput, validatedCommunityEmail } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { hashPassword, verifyPassword } from '../domain/password.js'
import type { CommunityUserSpaceReaderPort, CommunityUserSpaceRecord } from '../ports/community-user-spaces.js'
import type { CommunityAccountRegistration, CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { CommunityGroupRecord } from '../domain/community-group.js'
import { assertCommunityGroupRole, assertGroupDeletion, assertOrdinaryGroup, requiredCommunityGroup, validatedGroupName } from '../domain/community-group.js'
import { AdvisoryLock, transactionLock } from './advisory-locks.js'

/** Community identity persistence through the shared platform PostgreSQL owner. */
export class PostgresCommunityAccountStore implements CommunityAccountStorePort, CommunityUserSpaceReaderPort {
  private readonly dummyHash = hashPassword(randomBytes(32).toString('base64url'))
  constructor(private readonly database: PlatformDatabase) {}
  async bootstrapComplete(): Promise<boolean> {
    return (await this.database.query<{ completed: boolean }>('SELECT completed FROM dsh_phalanx.bootstrap_state WHERE id=1'))[0]!.completed
  }
  async createFirstAdmin(input: CommunityCreateAccountInput): Promise<CommunityAccountRecord> {
    return await this.insert(input, true)
  }
  async create(input: CommunityCreateAccountInput): Promise<CommunityAccountRecord> {
    return await this.insert(input, false)
  }
  private async insert(input: CommunityCreateAccountInput, firstAdmin: boolean): Promise<CommunityAccountRecord> {
    const { email } = validatedCommunityAccountInput(input),
      digest = await hashPassword(input.password)
    return await this.database.transaction(async sql => {
      await sql.query(transactionLock(AdvisoryLock.accounts))
      if (firstAdmin) {
        const [state] = await sql.query<{ completed: boolean }>('SELECT completed FROM dsh_phalanx.bootstrap_state WHERE id=1 FOR UPDATE')
        if (state!.completed) throw new BusinessRuleError('conflict', 'Bootstrap is already complete', 'bootstrap-complete')
      }
      await this.assertAvailable(sql, input.username, email)
      const groups = await this.groups(sql),
        groupId = firstAdmin ? 'admin' : (input.groupId ?? groups.find(row => row.isDefault)!.id)
      assertCommunityGroupRole(requiredCommunityGroup(groups, groupId), firstAdmin)
      const now = Date.now(),
        spaceId = randomBytes(16).toString('hex')
      const retired = (await sql.query('SELECT 1 FROM dsh_phalanx.retired_accounts WHERE username=$1', [input.username])).length > 0
      const storageKey = retired ? `_spaces/${spaceId}` : input.username
      const [row] = await sql.query<AccountRow>(
        `INSERT INTO dsh_phalanx.accounts(username,email,password_hash,admin,created_at,updated_at,space_id,storage_key,group_id)
        VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8) RETURNING *`,
        [input.username, email || null, digest, firstAdmin, now, spaceId, storageKey, groupId],
      )
      if (firstAdmin) await sql.query('UPDATE dsh_phalanx.bootstrap_state SET completed=true WHERE id=1')
      return publicRecord(row!)
    })
  }
  async listGroups(): Promise<readonly CommunityGroupRecord[]> {
    return await this.groups(this.database)
  }
  async createGroup(name: string): Promise<CommunityGroupRecord> {
    return await this.database.transaction(async sql => {
      await sql.query(transactionLock(AdvisoryLock.accounts))
      const value = validatedGroupName(await this.groups(sql), name),
        id = randomBytes(16).toString('hex')
      await sql.query("INSERT INTO dsh_phalanx.groups(id,name,kind) VALUES($1,$2,'ordinary')", [id, value])
      return { id, name: value, kind: 'ordinary', isDefault: false, memberCount: 0 }
    })
  }
  async setDefaultGroup(id: string): Promise<void> {
    await this.database.transaction(async sql => {
      await sql.query(transactionLock(AdvisoryLock.accounts))
      assertOrdinaryGroup(requiredCommunityGroup(await this.groups(sql), id))
      await sql.query('UPDATE dsh_phalanx.groups SET is_default=false WHERE is_default')
      await sql.query('UPDATE dsh_phalanx.groups SET is_default=true WHERE id=$1', [id])
    })
  }
  private async groups(sql: PlatformSql): Promise<readonly CommunityGroupRecord[]> {
    const rows = await sql.query<{
      id: string
      name: string
      kind: 'ordinary' | 'admin'
      is_default: boolean
      member_count: string
    }>(`SELECT g.*,count(a.username) AS member_count FROM dsh_phalanx.groups g
      LEFT JOIN dsh_phalanx.accounts a ON a.group_id=g.id GROUP BY g.id ORDER BY g.name,g.id`)
    return rows.map(row => ({ id: row.id, name: row.name, kind: row.kind, isDefault: row.is_default, memberCount: Number(row.member_count) }))
  }
  async get(username: string): Promise<CommunityAccountRecord | undefined> {
    const row = await this.row(this.database, username)
    return row ? publicRecord(row) : undefined
  }
  async getState(username: string): Promise<CommunityAccountState | undefined> {
    const row = await this.row(this.database, username)
    return row ? { username: row.username, spaceId: row.space_id, disabled: row.disabled, sessionEpoch: Number(row.session_epoch) } : undefined
  }
  async authenticate(username: string, password: string): Promise<CommunityAccountRecord | undefined> {
    const row = await this.row(this.database, username)
    const valid = await verifyPassword(password, row?.password_hash ?? (await this.dummyHash))
    const current = await this.row(this.database, username)
    return valid && row && current?.password_hash === row.password_hash && !current.disabled ? publicRecord(current) : undefined
  }
  async resetPassword(username: string, password: string): Promise<void> {
    validateCommunityPassword(password)
    const digest = await hashPassword(password)
    await this.database.transaction(async sql => {
      await sql.query(transactionLock(AdvisoryLock.accounts))
      const current = await this.required(sql, username)
      await sql.query('UPDATE dsh_phalanx.accounts SET password_hash=$1,session_epoch=session_epoch+1,updated_at=$2 WHERE username=$3', [
        digest,
        Date.now(),
        current.username,
      ])
    })
  }
  async setDisabled(username: string, disabled: boolean): Promise<CommunityAccountRecord> {
    return await this.database.transaction(async sql => {
      await sql.query(transactionLock(AdvisoryLock.accounts))
      const current = await this.required(sql, username)
      const [admins] = await sql.query<{ total: string }>('SELECT count(*) AS total FROM dsh_phalanx.accounts WHERE admin AND NOT disabled')
      assertCommunityAdminChange(current, { admin: current.admin, disabled }, Number(admins!.total))
      if (current.disabled === disabled) return current
      const [row] = await sql.query<AccountRow>(
        'UPDATE dsh_phalanx.accounts SET disabled=$1,session_epoch=session_epoch+$2,updated_at=$3 WHERE username=$4 RETURNING *',
        [disabled, disabled ? 1 : 0, Date.now(), current.username],
      )
      return publicRecord(row!)
    })
  }
  async list(): Promise<readonly CommunityAccountRecord[]> {
    return (await this.database.query<AccountRow>('SELECT * FROM dsh_phalanx.accounts ORDER BY username')).map(publicRecord)
  }
  async setAdmin(username: string, admin: boolean, targetGroupId?: string): Promise<CommunityAccountRecord> {
    return await this.database.transaction(async sql => {
      await sql.query(transactionLock(AdvisoryLock.accounts))
      const current = await this.required(sql, username)
      const [admins] = await sql.query<{ total: string }>('SELECT count(*) AS total FROM dsh_phalanx.accounts WHERE admin AND NOT disabled')
      assertCommunityAdminChange(current, { admin, disabled: current.disabled }, Number(admins!.total))
      if (!admin && targetGroupId === undefined) throw new BusinessRuleError('invalid', 'Select a target group', 'group-required')
      const groupId = admin ? 'admin' : targetGroupId!
      assertCommunityGroupRole(requiredCommunityGroup(await this.groups(sql), groupId), admin)
      const [row] = await sql.query<AccountRow>('UPDATE dsh_phalanx.accounts SET admin=$1,group_id=$2,updated_at=$3 WHERE username=$4 RETURNING *', [
        admin,
        groupId,
        Date.now(),
        current.username,
      ])
      return publicRecord(row!)
    })
  }
  async withCurrentState<T>(username: string, register: CommunityAccountRegistration<T>): Promise<T> {
    const cleanups: (() => void)[] = []
    try {
      return await this.database.transaction(async sql => {
        const row = await this.row(sql, username, true)
        const result = register(row ? publicRecord(row) : undefined, cleanup => {
          cleanups.push(cleanup)
        })
        if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result)
          throw Error('Account admission registration must be synchronous')
        return result
      })
    } catch (error) {
      const failures: unknown[] = [error]
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup()
        } catch (failure) {
          failures.push(failure)
        }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'Account admission cleanup failed')
      throw error
    }
  }
  async setAccountDetails(username: string, email: string, groupId?: string): Promise<CommunityAccountRecord> {
    return await this.database.transaction(async sql => {
      await sql.query(transactionLock(AdvisoryLock.accounts))
      const current = await this.required(sql, username)
      const value = email.trim() === '' && current.email === '' ? null : validatedCommunityEmail(email)
      const target = groupId ?? current.groupId
      assertCommunityGroupRole(requiredCommunityGroup(await this.groups(sql), target), current.admin)
      if ((await sql.query('SELECT 1 FROM dsh_phalanx.accounts WHERE lower(email)=lower($1) AND username<>$2', [value, current.username])).length)
        throw new BusinessRuleError('conflict', 'Email is already in use', 'email-in-use')
      const [row] = await sql.query<AccountRow>('UPDATE dsh_phalanx.accounts SET email=$1,group_id=$2,updated_at=$3 WHERE username=$4 RETURNING *', [
        value,
        target,
        Date.now(),
        current.username,
      ])
      return publicRecord(row!)
    })
  }
  async renameGroup(id: string, name: string): Promise<CommunityGroupRecord> {
    return await this.database.transaction(async sql => {
      await sql.query(transactionLock(AdvisoryLock.accounts))
      const groups = await this.groups(sql),
        group = requiredCommunityGroup(groups, id),
        value = validatedGroupName(groups, name, id)
      await sql.query('UPDATE dsh_phalanx.groups SET name=$1 WHERE id=$2', [value, id])
      return { ...group, name: value }
    })
  }
  async deleteGroup(id: string): Promise<void> {
    await this.database.transaction(async sql => {
      await sql.query(transactionLock(AdvisoryLock.accounts))
      assertGroupDeletion(requiredCommunityGroup(await this.groups(sql), id))
      await sql.query('DELETE FROM dsh_phalanx.groups WHERE id=$1', [id])
    })
  }
  async delete(username: string): Promise<void> {
    await this.database.transaction(async sql => {
      await sql.query(transactionLock(AdvisoryLock.accounts))
      const current = await this.required(sql, username)
      const [admins] = await sql.query<{ total: string }>('SELECT count(*) AS total FROM dsh_phalanx.accounts WHERE admin AND NOT disabled')
      assertCommunityAdminChange(current, undefined, Number(admins!.total))
      await sql.query(
        'INSERT INTO dsh_phalanx.retired_accounts(username,retired_at) VALUES($1,$2) ON CONFLICT(username) DO UPDATE SET retired_at=excluded.retired_at',
        [current.username, Date.now()],
      )
      await sql.query('DELETE FROM dsh_phalanx.accounts WHERE username=$1', [current.username])
    })
  }
  async getSpace(username: string): Promise<CommunityUserSpaceRecord | undefined> {
    const row = await this.row(this.database, username)
    return row ? { spaceId: row.space_id, storageKey: row.storage_key } : undefined
  }
  private async assertAvailable(sql: PlatformSql, username: string, email: string): Promise<void> {
    if (await this.row(sql, username)) throw new BusinessRuleError('conflict', 'Username is already in use', 'username-in-use')
    if (email && (await sql.query('SELECT 1 FROM dsh_phalanx.accounts WHERE lower(email)=lower($1)', [email])).length)
      throw new BusinessRuleError('conflict', 'Email is already in use', 'email-in-use')
  }
  private async required(sql: PlatformSql, username: string): Promise<CommunityAccountRecord> {
    const row = await this.row(sql, username, true)
    if (!row) throw new BusinessRuleError('missing', 'Account was not found', 'account-not-found')
    return publicRecord(row)
  }
  private async row(sql: PlatformSql, username: string, lock = false): Promise<AccountRow | undefined> {
    return (await sql.query<AccountRow>('SELECT * FROM dsh_phalanx.accounts WHERE username=$1' + (lock ? ' FOR UPDATE' : ''), [username.toLowerCase()]))[0]
  }
}
