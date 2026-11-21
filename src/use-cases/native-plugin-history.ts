import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import type { NativeFeatureMember } from '../ports/native-features.js'
import type {
  MemberNativePluginHistory,
  NativeOptionalBundle,
  NativePluginHistoryPersistence,
  NativePluginHistoryRuntime,
} from '../ports/native-plugin-history.js'

interface HistorySync {
  readonly member: NativeFeatureMember
  readonly instance: CommunityUserInstance
  readonly signal: AbortSignal
  pending?: Promise<readonly string[]>
  followUp?: Promise<readonly string[]>
  retry?: { observation: Promise<readonly string[]>; start: () => void }
  write?: Promise<readonly string[]>
  delay: number
}

/** Eligibility is an append-only platform fact scoped to the current user space. */
export class NativePluginHistory implements MemberNativePluginHistory {
  private readonly syncs = new WeakMap<CommunityUserInstance, HistorySync>()

  constructor(
    private readonly persistence: NativePluginHistoryPersistence,
    private readonly runtime: NativePluginHistoryRuntime,
    private readonly pendingArchive?: (instance: CommunityUserInstance, integrity: string) => boolean,
  ) {}
  async initialize(member: NativeFeatureMember, instance: CommunityUserInstance, signal: AbortSignal): Promise<readonly string[]> {
    this.assertTarget(member, instance)
    signal.throwIfAborted()
    this.assertTarget(member, this.runtime.current(member.username, true), instance.resourceKey)
    const sync = this.syncFor(member, instance, signal)
    return await (sync.pending ?? sync.retry?.observation ?? this.observe(sync))
  }
  private syncFor(member: NativeFeatureMember, instance: CommunityUserInstance, signal?: AbortSignal): HistorySync {
    const existing = this.syncs.get(instance)
    if (existing) return existing
    const lifetime = signal ?? new AbortController().signal
    const sync: HistorySync = { member, instance, signal: lifetime, delay: 1_000 }
    this.syncs.set(instance, sync)
    return sync
  }
  async request(member: NativeFeatureMember, generation: string, mode: 'read' | 'refresh', signal: AbortSignal): Promise<readonly string[]> {
    signal.throwIfAborted()
    const instance = this.runtime.current(member.username)
    this.assertTarget(member, instance, generation)
    const assertCurrent = () => {
      signal.throwIfAborted()
      this.assertTarget(member, this.runtime.current(member.username), generation)
    }
    const sync = mode === 'refresh' ? this.syncFor(member, instance!) : undefined
    const names = sync ? await this.waitForRefresh(this.refresh(sync), signal) : await this.record(member, undefined, assertCurrent)
    assertCurrent()
    return names
  }
  async drainWrites(instance: CommunityUserInstance): Promise<void> {
    await this.syncs.get(instance)?.write?.catch(() => {})
  }
  private waitForRefresh(pending: Promise<readonly string[]>, signal: AbortSignal): Promise<readonly string[]> {
    return new Promise((resolve, reject) => {
      const cancel = () => reject(signal.reason)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
    })
  }
  private refresh(sync: HistorySync): Promise<readonly string[]> {
    if (sync.retry) {
      const retry = sync.retry
      retry.start()
      return retry.observation
    }
    if (!sync.pending) return this.observe(sync)
    // A query already started may predate the operation that requested refresh.
    return (sync.followUp ??= sync.pending.then(
      () => {
        delete sync.followUp
        return this.observe(sync)
      },
      error => {
        delete sync.followUp
        throw error
      },
    ))
  }
  private observe(sync: HistorySync): Promise<readonly string[]> {
    const { member, instance, signal } = sync
    const assertCurrent = () => {
      signal.throwIfAborted()
      this.assertTarget(member, this.runtime.current(member.username, true), instance.resourceKey)
    }
    const operation = async () => {
      assertCurrent()
      const holds = this.runtime.inspectInventory
        ? await this.persistence.work.run(rows => rows.deliveries.browserDeliveries?.(member.spaceId, instance.resourceKey!) ?? Promise.resolve([]))
        : []
      const inventory = holds.length ? await this.runtime.inspectInventory?.(instance, signal) : undefined
      const bundles = inventory?.optional ?? (await this.runtime.inspect(instance, signal))
      const installed = inventory?.installed
      const missing = installed
        ? holds.flatMap(hold => {
            const actual = installed.get(hold.packageName)
            return !actual ||
              (actual.version !== undefined && actual.version !== hold.version) ||
              (actual.integrity !== undefined && actual.integrity !== hold.integrity)
              ? [hold.revision]
              : []
          })
        : []
      assertCurrent()
      const write = this.record(
        member,
        bundles,
        assertCurrent,
        () => {
          sync.write = write
        },
        missing,
        instance.resourceKey,
      )
      try {
        return await write
      } finally {
        delete sync.write
      }
    }
    const pending = operation()
    sync.pending = pending
    void pending.then(
      () => {
        delete sync.pending
        sync.delay = 1_000
      },
      error => {
        delete sync.pending
        if (signal.aborted || (error instanceof BusinessRuleError && error.code === 'native-plugin-instance-stale')) return
        console.warn(
          error instanceof Error && error.name === 'TimeoutError' ? 'Native plugin history observation timed out' : 'Native plugin history observation failed',
        )
        this.scheduleRetry(sync)
      },
    )
    return pending
  }
  private scheduleRetry(sync: HistorySync): void {
    const { signal } = sync
    let start!: () => void
    const observation = new Promise<readonly string[]>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        delete sync.retry
        reject(signal.reason)
      }
      start = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        delete sync.retry
        void this.observe(sync).then(resolve, reject)
      }
      const timer = setTimeout(start, sync.delay)
      timer.unref()
      signal.addEventListener('abort', abort, { once: true })
    })
    sync.retry = { observation, start }
    void observation.catch(() => {})
    sync.delay = Math.min(30_000, sync.delay * 2)
  }
  async archiveReserved(member: NativeFeatureMember, generation: string, integrity: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    this.assertTarget(member, this.runtime.current(member.username), generation)
    return await this.persistence.work.run(async repositories => {
      await repositories.actors.lockMember(member)
      const deliveries = await repositories.deliveries.get(member.spaceId)
      const browserReserved = await repositories.deliveries.isBrowserArchiveReserved?.(member.spaceId, integrity)
      signal.throwIfAborted()
      const instance = this.runtime.current(member.username)
      this.assertTarget(member, instance, generation)
      return (
        this.pendingArchive?.(instance!, integrity) === true ||
        deliveries.some(row => row.integrity === integrity && (row.serviceOrigin !== undefined || row.resourceOrigin !== undefined)) ||
        browserReserved === true
      )
    })
  }
  private record(
    member: NativeFeatureMember,
    bundles: readonly NativeOptionalBundle[] | undefined,
    assertCurrent: () => void,
    readyToCommit?: () => void,
    missingBrowsers: readonly string[] = [],
    generation?: string,
  ): Promise<readonly string[]> {
    return this.persistence.work.run(async repositories => {
      await repositories.actors.lockMember(member)
      assertCurrent()
      const existing = await repositories.history.read(member.spaceId)
      assertCurrent()
      if (!bundles) {
        if (!existing) throw new BusinessRuleError('conflict', 'Native plugin history is not initialized.', 'native-plugin-history-unavailable')
        return existing
      }
      const eligible = bundles
        .filter(bundle => (existing === undefined ? bundle.enabled || bundle.installed : bundle.enabled && !bundle.failed))
        .map(bundle => bundle.name)
      const remembered = await repositories.history.remember(member.spaceId, eligible)
      if (missingBrowsers.length && generation) await repositories.deliveries.releaseMissingBrowserDeliveries?.(member.spaceId, missingBrowsers, generation)
      assertCurrent()
      // A transaction waiting on database I/O above will still roll back after cancellation.
      readyToCommit?.()
      return remembered
    })
  }
  private assertTarget(member: NativeFeatureMember, instance: CommunityUserInstance | undefined, generation?: string): void {
    if (
      !instance ||
      instance.userId !== member.username ||
      instance.spaceId !== member.spaceId ||
      !instance.resourceKey ||
      (generation !== undefined && instance.resourceKey !== generation)
    )
      throw new BusinessRuleError('forbidden', 'The native plugin request belongs to an inactive instance.', 'native-plugin-instance-stale')
  }
}
