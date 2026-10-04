export interface CommunityUserStorageMigrationResult {
  readonly sourceRoot: string
  readonly targetRoot: string
  readonly targetMount: string
  readonly recovery: string
}
export interface CommunityUserStorageMigrationPort {
  prepare(targetRoot: string, targetMount: string): Promise<{ readonly state: 'pending' } | { readonly state: 'complete', readonly result: CommunityUserStorageMigrationResult }>
  stopCarriers(): Promise<void>
  copy(): Promise<void>
  verify(): Promise<void>
  publish(): Promise<CommunityUserStorageMigrationResult>
  close(): Promise<void>
}
