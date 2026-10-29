import type { CommunityErrorCode, CommunityStartupView } from '../domain/admin-contract.js'
import type { CommunityInstanceActions } from './community-instance-actions.js'
import { communitySpacePath } from '../domain/community-space.js'
import { CommunityAuthenticationError, type CommunityAccountState } from '../domain/community-account.js'
import type { CommunityAccountOnboardingStorePort } from '../ports/community-accounts.js'
import type { CommunityUserSpaceStoragePort } from '../ports/community-user-spaces.js'
import type { DshSessionPort } from '../ports/dsh-session.js'
import { CommunityRuntimeUnavailableError, type CommunityRuntimePort, type CommunityUserInstance } from '../ports/community-runtime.js'

/** Entry selects only the authenticated account's instance and rechecks durable access after startup. */
interface EntryStartup {
  readonly spaceId: string
  readonly sessionEpoch: number
  readonly promise: Promise<unknown>
  code?: CommunityErrorCode
  failedInstance?: CommunityUserInstance
}
export class CommunityEntry {
  private closed = false
  private readonly starts = new Map<string, EntryStartup>()
  constructor(
    private readonly accounts: Pick<CommunityAccountOnboardingStorePort, 'authenticate' | 'getState'>,
    private readonly runtime: CommunityRuntimePort,
    private readonly session: Pick<DshSessionPort, 'exchangeLaunchToken' | 'hasSession' | 'forgetSession'>,
    private readonly storage?: Pick<CommunityUserSpaceStoragePort, 'assertAvailable'>,
    private readonly actions?: Pick<CommunityInstanceActions, 'restart'>,
  ) {}

  async account(userId: string): Promise<CommunityAccountState> {
    if (this.closed) throw new CommunityRuntimeUnavailableError('authorization-unavailable', 'Community entry is closed')
    const account = await this.accounts.getState(userId)
    if (this.closed || account === undefined || account.disabled) throw new CommunityAuthenticationError('Account is no longer active', 'account-inactive')
    return account
  }
  async spacePath(userId: string): Promise<string> {
    return communitySpacePath((await this.account(userId)).spaceId)
  }
  async accessClosed(userId: string): Promise<boolean> {
    const account = await this.accounts.getState(userId)
    return account === undefined || account.disabled
  }
  async ensure(userId: string, origin: URL): Promise<CommunityUserInstance> {
    await this.storage?.assertAvailable()
    if (await this.accessClosed(userId)) throw new CommunityRuntimeUnavailableError('authorization-unavailable', 'Account is no longer active')
    try {
      return await this.runtime.ensure(userId, origin.href)
    } catch (error) {
      if (error instanceof CommunityRuntimeUnavailableError) throw error
      throw new CommunityRuntimeUnavailableError(
        'startup-unavailable',
        'DSH could not start. Use the platform recovery page or ask an administrator to reset its environment.',
        { cause: error },
      )
    }
  }
  async current(userId: string, instance: CommunityUserInstance): Promise<boolean> {
    const closed = await this.accessClosed(userId)
    return !closed && this.currentInstance(userId, instance)
  }
  /** Local instance identity can be rechecked inside a durable account admission fence. */
  currentInstance(userId: string, instance: CommunityUserInstance): boolean {
    const status = this.runtime.status(userId)
    return (
      status.state === 'ready' &&
      status.instance.userId === userId &&
      status.instance.processId === instance.processId &&
      status.instance.origin === instance.origin
    )
  }
  async status(userId: string) {
    await this.storage?.assertAvailable()
    await this.account(userId)
    return this.runtime.status(userId)
  }
  async startup(userId: string): Promise<CommunityStartupView> {
    const account = await this.account(userId)
    let status
    try {
      status = await this.status(userId)
    } catch (error) {
      if (error instanceof CommunityRuntimeUnavailableError) return { state: 'failed', code: error.code }
      throw error
    }
    if (status.state === 'ready') {
      const attempt = this.starts.get(userId)
      if (attempt?.spaceId === account.spaceId && attempt.sessionEpoch === account.sessionEpoch) {
        if (!attempt.code) return { state: 'connecting' }
        if (attempt.failedInstance === status.instance) return { state: 'failed', code: attempt.code }
      }
      this.starts.delete(userId)
      return { state: 'ready' }
    }
    if (status.state === 'starting' || status.state === 'draining') return { state: status.state === 'starting' ? (status.stage ?? 'preparing') : 'preparing' }
    const attempt = this.starts.get(userId)
    return attempt?.spaceId === account.spaceId && attempt.sessionEpoch === account.sessionEpoch && attempt.code
      ? { state: 'failed', code: attempt.code }
      : { state: 'preparing' }
  }
  /** Navigation starts work without holding the HTTP response. */
  async start(userId: string, origin: URL): Promise<void> {
    const account = await this.account(userId),
      pending = this.starts.get(userId)
    const operation =
      pending?.spaceId === account.spaceId && pending.sessionEpoch === account.sessionEpoch && !pending.code
        ? pending.promise
        : this.observe(account, () => this.ensureEntry(account, origin))
    return operation.then(
      () => {},
      () => {},
    )
  }
  async restart(account: CommunityAccountState, origin: URL): Promise<string[]> {
    return await this.observe(account, async () => {
      if (!this.actions) throw new CommunityRuntimeUnavailableError('startup-unavailable', 'Instance restart is unavailable')
      await this.actions.restart(account, origin)
      return await this.openSpace(account, origin)
    })
  }
  async navigate(userId: string, origin: URL, cookie: string | undefined) {
    const account = await this.account(userId)
    return await this.observe(account, () => this.admit(account, origin, cookie))
  }

  async reconcile(): Promise<void> {
    for (const [userId, attempt] of this.starts) {
      const account = await this.accounts.getState(userId)
      if (!account || account.disabled || account.spaceId !== attempt.spaceId || account.sessionEpoch !== attempt.sessionEpoch) this.starts.delete(userId)
    }
  }
  close(): void {
    this.closed = true
    this.starts.clear()
  }
  private observe<T>(account: CommunityAccountState, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new CommunityRuntimeUnavailableError('authorization-unavailable', 'Community entry is closed'))
    const task = Promise.resolve()
      .then(operation)
      .then(
        value => {
          if (this.starts.get(account.username) === attempt) this.starts.delete(account.username)
          return value
        },
        error => {
          if (this.starts.get(account.username) === attempt) {
            attempt.code = error instanceof CommunityRuntimeUnavailableError ? error.code : 'runtime-startup-unavailable'
            const status = this.runtime.status(account.username)
            if (status.state === 'ready' || status.state === 'draining') attempt.failedInstance = status.instance
          }
          throw error
        },
      )
    const attempt: EntryStartup = { spaceId: account.spaceId, sessionEpoch: account.sessionEpoch, promise: task }
    this.starts.set(account.username, attempt)
    return task
  }

  private async assertCurrent(account: CommunityAccountState): Promise<void> {
    this.assertState(account, await this.accounts.getState(account.username))
  }
  private assertState(account: CommunityAccountState, fresh: CommunityAccountState | undefined): void {
    if (this.closed || fresh === undefined || fresh.disabled || fresh.spaceId !== account.spaceId || fresh.sessionEpoch !== account.sessionEpoch)
      throw new CommunityRuntimeUnavailableError('authorization-unavailable', 'Account access changed during entry; retry')
  }
  async signIn(username: string, password: string) {
    const account = await this.accounts.authenticate(username, password)
    if (account === undefined) throw new CommunityAuthenticationError('Invalid username or password', 'credentials-invalid')
    const fresh = await this.accounts.getState(account.username)
    if (this.closed || fresh === undefined || fresh.disabled || fresh.spaceId !== account.spaceId || fresh.sessionEpoch !== account.sessionEpoch)
      throw new CommunityRuntimeUnavailableError('authorization-unavailable', 'Account access changed during sign in; retry')
    const status = this.runtime.status(account.username)
    if (status.state === 'ready' || status.state === 'draining') this.session.forgetSession?.(status.instance)
    return { account, cookies: [] as string[] }
  }

  async openSpace(account: CommunityAccountState, origin: URL): Promise<string[]> {
    return (await this.admit(account, origin)).cookies
  }
  private async ensureEntry(account: CommunityAccountState, origin: URL): Promise<CommunityUserInstance> {
    await this.runtime.waitForMaintenance?.(account.username)
    await this.assertCurrent(account)
    return await this.ensure(account.username, origin)
  }
  private async admit(account: CommunityAccountState, origin: URL, cookie?: string): Promise<{ instance: CommunityUserInstance; cookies: string[] }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const instance = await this.ensureEntry(account, origin)
      if (cookie !== undefined && this.session.hasSession?.(instance, cookie)) {
        this.assertState(account, await this.accounts.getState(account.username))
        if (this.currentInstance(account.username, instance)) return { instance, cookies: [] }
        continue
      }
      let cookies: string[]
      try {
        cookies = await this.session.exchangeLaunchToken(instance, origin)
      } catch (error) {
        if (!(await this.current(account.username, instance))) continue
        throw new CommunityRuntimeUnavailableError('startup-unavailable', 'DSH login could not be completed. Use the platform recovery page.', { cause: error })
      }
      this.assertState(account, await this.accounts.getState(account.username))
      if (this.currentInstance(account.username, instance)) return { instance, cookies }
    }
    throw new CommunityRuntimeUnavailableError('start-cancelled', 'User instance changed during sign in; retry')
  }
}
