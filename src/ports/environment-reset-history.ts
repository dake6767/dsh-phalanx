import type { EnvironmentResetHistory } from '../domain/environment-reset-history.js'

/** Acceptance is durable before any connection or runtime side effect begins. */
export interface EnvironmentResetHistoryPort {
  get(spaceId: string): EnvironmentResetHistory | undefined
  save(spaceId: string, record: EnvironmentResetHistory): void
}
