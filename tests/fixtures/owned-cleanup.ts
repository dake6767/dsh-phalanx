import { rm } from 'node:fs/promises'
import { durableStorageRoot } from '../../src/domain/storage-layout.js'

/** Cleanup remains ordered, attempts every owned resource and preserves each failure. */
export async function cleanupOwned(...operations: readonly (() => Promise<unknown>)[]): Promise<void> {
  const failures: unknown[] = []
  for (const operation of operations) {
    try {
      await operation()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Owned fixture cleanup failed')
}

/** The allocating test owns both its temporary platform root and the sibling durable namespace. */
export function removeCommunityFixture(dataRoot: string): Promise<void> {
  return cleanupOwned(
    () => rm(dataRoot, { recursive: true, force: true }),
    () => rm(durableStorageRoot(dataRoot), { recursive: true, force: true }),
  )
}
