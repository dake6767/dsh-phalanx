import { setTimeout as delay } from 'node:timers/promises'
import type { PlatformVoiceSettingsView } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { PlatformVoicePreparationError } from '../domain/platform-voice.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { PlatformVoiceAssetsPort, PlatformVoiceState, PlatformVoiceStore } from '../ports/platform-voice.js'

/** Own the single deployment preparation job. Revision fences prevent stale work publishing a selection. */
export class PlatformVoice {
  private job?: { readonly revision: number; readonly abort: AbortController; readonly done: Promise<void>; received: number }
  private stopped = false

  constructor(
    private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>,
    private readonly store: PlatformVoiceStore,
    private readonly assets: PlatformVoiceAssetsPort,
  ) {}

  async view(actor: CommunityAccountActor): Promise<PlatformVoiceSettingsView> {
    await this.assertAdmin(actor)
    return this.withProgress(await this.store.state())
  }

  async save(actor: CommunityAccountActor, input: unknown): Promise<PlatformVoiceSettingsView> {
    await this.assertAdmin(actor)
    const row = input as Record<string, unknown> | null
    if (
      !row ||
      typeof row !== 'object' ||
      Object.keys(row).length !== 3 ||
      typeof row.revision !== 'number' ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      typeof row.enabled !== 'boolean' ||
      (row.precision !== 'int8' && row.precision !== 'fp32')
    )
      throw new BusinessRuleError('invalid', 'Check the platform voice settings and try again.', 'platform-voice-settings-invalid')
    const state = await this.store.save({ revision: row.revision, enabled: row.enabled, precision: row.precision })
    this.schedule(state)
    return this.withProgress(state)
  }

  async start(): Promise<void> {
    const state = await this.store.state()
    if (state.status === 'ready' && !(await this.available(state.precision))) {
      this.schedule(await this.store.save({ revision: state.revision, enabled: true, precision: state.precision }))
      return
    }
    this.schedule(state)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.job?.abort.abort()
    await this.job?.done
  }

  async prepared() {
    const state = await this.store.state()
    if (state.enabled && state.activePrecision) return await this.available(state.activePrecision)
    return undefined
  }

  private async available(precision: NonNullable<PlatformVoiceState['activePrecision']>) {
    try {
      return await this.assets.available(precision)
    } catch {
      return undefined
    }
  }

  private withProgress(state: PlatformVoiceState): PlatformVoiceSettingsView {
    if (state.status !== 'preparing') return state
    const received = this.job?.revision === state.revision ? this.job.received : 0
    return { ...state, progress: { received, total: this.assets.bytes(state.precision) } }
  }

  private schedule(state: PlatformVoiceState): void {
    const prior = this.job
    if (this.stopped || (prior && prior.revision >= state.revision)) return
    prior?.abort.abort()
    const abort = new AbortController()
    const job = {
      revision: state.revision,
      received: 0,
      abort,
      done: Promise.resolve(prior?.done)
        .then(async () => {
          if (abort.signal.aborted || state.status !== 'preparing') return
          try {
            await this.assets.prepare(state.precision, received => (job.received = received), abort.signal)
          } catch (failure) {
            if (!abort.signal.aborted)
              await this.publish(state.revision, { failure: failure instanceof PlatformVoicePreparationError ? failure.code : 'storage' }, abort.signal)
            return
          }
          if (!abort.signal.aborted) await this.publish(state.revision, { ready: true }, abort.signal)
        })
        .catch(() => console.warn('Platform voice preparation could not store its result')),
    }
    this.job = job
  }

  private async publish(revision: number, result: Parameters<PlatformVoiceStore['settle']>[1], signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.store.settle(revision, result)
        return
      } catch {
        // The prepared bytes remain available. Retry publishing only this fenced outcome.
        await delay(2_000, undefined, { signal, ref: false }).catch(() => {})
      }
    }
  }

  private async assertAdmin(actor: CommunityAccountActor): Promise<void> {
    const current = await this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
