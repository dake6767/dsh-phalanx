export interface CommunityUserStorageMigrationResult {
  readonly sourceRoot: string
  readonly targetRoot: string
  readonly targetMount: string | null
  readonly recovery: string
  readonly direction?: 'rollback'
}
export interface CommunityUserStorageMigrationPort {
  prepare(
    targetRoot: string,
    targetMount: string,
    direction?: 'forward' | 'rollback',
  ): Promise<{ readonly state: 'pending' } | { readonly state: 'complete'; readonly result: CommunityUserStorageMigrationResult }>
  stopCarriers(): Promise<void>
  copy(): Promise<void>
  verify(): Promise<void>
  publish(): Promise<CommunityUserStorageMigrationResult>
  rollback(): Promise<CommunityUserStorageMigrationResult>
  close(): Promise<void>
}
