import { performance } from 'node:perf_hooks'
import type { CommunityStartupStage } from '../domain/admin-contract.js'

/** Phase receipts contain no account identity, launch URLs, credentials or member content. */
export class StartupTiming {
  private stage: CommunityStartupStage = 'preparing'
  private started: number
  constructor(private readonly publish: (stage: CommunityStartupStage) => void = () => {},
    private readonly now: () => number = () => performance.now(), private readonly log: (receipt: { event: string, stage: string, durationMs: number }) => void = receipt => console.info(JSON.stringify(receipt))) { this.started = now() }
  advance(stage: CommunityStartupStage): void { this.finish(); this.stage = stage; this.started = this.now(); this.publish(stage) }
  finish(): void { this.log({ event: 'community-startup-phase', stage: this.stage, durationMs: Math.max(0, this.now() - this.started) }) }
  async checking<T>(run: () => Promise<T>): Promise<T> {
    const started = this.now()
    try { return await run() }
    finally { this.log({ event: 'community-startup-phase', stage: 'checking', durationMs: Math.max(0, this.now() - started) }) }
  }
}
