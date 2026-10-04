/** Persisted directory mapping is distinct from the public opaque identity. */
export interface CommunityUserSpaceRecord {
  readonly spaceId: string
  readonly storageKey: string
}

export interface CommunityUserSpaceReaderPort {
  getSpace(username: string): CommunityUserSpaceRecord | undefined
}

export interface CommunityUserSpaceStoragePort {
  assertAvailable(): void
  prepare(username: string): Promise<{ readonly home: string, readonly workspace: string, readonly spaceId: string }>
}
