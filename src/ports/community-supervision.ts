import type { CommunityApplication } from './community-application.js'

/** Stable public availability outlives each disposable business graph. */
export interface CommunitySupervisionPort {
  readonly entry: { start(): Promise<string>; suspend(reason?: 'configuration'): void; stop(): Promise<void> }
  create(): Promise<CommunityApplication>
  schedule(attempt: () => Promise<void>): () => void
  retryable(error: unknown): boolean
  report(error: unknown): void
}
