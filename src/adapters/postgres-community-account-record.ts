import type { CommunityAccountRecord } from '../domain/community-account.js'

export interface AccountRow extends Record<string, unknown> {
  username: string
  email: string | null
  password_hash: string
  admin: boolean
  disabled: boolean
  session_epoch: string
  created_at: string
  updated_at: string
  space_id: string
  storage_key: string
  group_id: string
}

export function publicRecord(row: AccountRow): CommunityAccountRecord {
  return {
    username: row.username,
    email: row.email ?? '',
    admin: row.admin,
    disabled: row.disabled,
    sessionEpoch: Number(row.session_epoch),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    spaceId: row.space_id,
    groupId: row.group_id,
  }
}
