import type { EnvironmentResetHistory } from '../domain/environment-reset-history.js'

/** Acceptance is durable before any connection or runtime side effect begins. */
export interface EnvironmentResetHistoryPort {
  get(spaceId: string): Promise<EnvironmentResetHistory | undefined>
  save(spaceId: string, record: EnvironmentResetHistory): Promise<void>
}
