import type { UserStorageBinding, UserStorageRecord } from '../domain/user-storage.js'

export interface UserStorageFacts {
  read(): Promise<UserStorageRecord | undefined>
  createOwner(candidate: string): Promise<UserStorageRecord>
  saveBinding(expectedRevision: number, binding: UserStorageBinding | null): Promise<UserStorageRecord>
}
/** The offline owner is opened only after acquiring the platform's local lock. */
export interface UserStorageMaintenance {
  open(): Promise<UserStorageFacts>
  close(): Promise<void>
}
