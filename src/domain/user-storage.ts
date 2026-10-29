/** The disk marker and mount identity belong to one platform-wide binding. */
export interface UserStorageBinding {
  readonly path: string
  readonly id: string
  readonly mount: string
}
export interface UserStorageRecord {
  readonly owner: string
  readonly revision: number
  readonly binding: UserStorageBinding | null
}

export function sameUserStorageBinding(left: UserStorageBinding | null, right: UserStorageBinding | null): boolean {
  return left === null ? right === null : right !== null && left.path === right.path && left.id === right.id && left.mount === right.mount
}

/** A stale offline publisher must reload rather than overwrite another storage switch. */
export class UserStorageBindingChanged extends Error {
  readonly code = 'storage-binding-changed'
  constructor() {
    super('User storage binding changed; reload it before publishing.')
  }
}
