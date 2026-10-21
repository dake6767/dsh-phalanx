import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { InstanceResourceStorePort } from '../ports/instance-resources.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { Clock } from '../ports/clock.js'

/** Stable-space eligibility and one automatic failure window per platform lifetime. */
export class ResidentInstances {
  private readonly failures = new Map<string, { at: number }>()
  private readonly attempts = new Map<string, Promise<void>>()
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list'>,
    private readonly store: Pick<InstanceResourceStorePort, 'read'>,
    private readonly runtime: Pick<CommunityRuntimePort, 'status' | 'queueStart' | 'cancelQueued'>,
    private readonly clock: Clock, private readonly origin: () => URL, private readonly admitted: () => boolean = () => true) {}

  failure(spaceId: string): { readonly at: number } | undefined { return this.failures.get(spaceId) }
  resident(username: string): boolean {
    const account = this.accounts.get(username)
    return !!account && this.store.read().residents[account.spaceId] === true
  }
  ready(username: string): void {
    const account = this.accounts.get(username)
    if (account) this.failures.delete(account.spaceId)
  }
  settingsChanged(): void { this.scan() }
  scan(): void {
    const accounts = this.accounts.list()
    if (!this.admitted()) { for (const account of accounts) this.runtime.cancelQueued?.(account.username); return }
    const state = this.store.read()
    const enabled = new Set(accounts.filter(account => !account.disabled && state.residents[account.spaceId]).map(account => account.spaceId))
    for (const spaceId of this.failures.keys()) if (!enabled.has(spaceId)) this.failures.delete(spaceId)
    for (const account of accounts) {
      if (!enabled.has(account.spaceId)) { this.runtime.cancelQueued?.(account.username); continue }
      if (this.failures.has(account.spaceId) || this.attempts.has(account.spaceId) || this.runtime.status(account.username).state !== 'stopped' || !this.runtime.queueStart) continue
      const current = () => {
        const latest = this.accounts.get(account.username)
        return this.admitted() && !!latest && !latest.disabled && latest.spaceId === account.spaceId
      }
      const eligible = () => current() && this.store.read().residents[account.spaceId] === true
      const task = this.runtime.queueStart(account.username, this.origin().href, eligible, current).then(() => {
        this.failures.delete(account.spaceId)
      }, (error: unknown) => {
        const reason = error && typeof error === 'object' && 'reason' in error ? error.reason : undefined
        if (eligible() && reason !== 'start-cancelled' && reason !== 'shutdown') this.failures.set(account.spaceId, { at: this.clock.now() })
      }).finally(() => { if (this.attempts.get(account.spaceId) === task) this.attempts.delete(account.spaceId) })
      this.attempts.set(account.spaceId, task)
    }
  }
  async drain(): Promise<void> { await Promise.all([...this.attempts.values()]) }
}
