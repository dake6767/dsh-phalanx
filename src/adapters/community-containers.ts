import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'
import type { ContainerHostnames } from '../ports/container-hostnames.js'
import { exitedContainerLockEvidence, liveLegacyProfileWriter, unclaimedProfileWriterHome, type LiveProfileWriter } from './container-write-lock.js'
import { readProfileLock, recoverMemberProfileWriteLock, restoreInterruptedProfileLock } from './member-profile-write-lock.js'
import { profileLockDispositionPending } from './profile-lock-disposition.js'
import { withProfileWriterAdmission } from './profile-writer-admission.js'
import { buildCommunityContainerLaunchCommand, parseManagedContainers, type ManagedContainerRecord } from '../dsh/container.js'
import { PROFILE_WRITER_HOME_LABEL } from '../dsh/container-write-lock.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

interface LegacyProfileWriterHandoff {
  readonly record: ManagedContainerRecord
  readonly home: string
  readonly proof: LiveProfileWriter
}

/** Lists and removes only this data root's carriers, optionally retaining a proven current-space identity. */
export class OwnedCommunityContainers {
  constructor(
    private readonly container: CommunityRuntimeConfig['container'],
    private readonly ownership: string,
    private readonly shutdownTimeoutMs = 10_000,
    private readonly existingHome?: (username: string, spaceId: string) => Promise<string | undefined>,
  ) {}
  private async ownedRecords(): Promise<readonly ManagedContainerRecord[]> {
    const container = this.container
    if (!container) return []
    const output = await execFileText(
      container.runtime,
      [
        'ps',
        '--all',
        '--no-trunc',
        '--filter',
        'label=dsh-phalanx.community=1',
        '--filter',
        `label=dsh-phalanx.community-root=${this.ownership}`,
        '--format',
        'json',
      ],
      { env: containerClientEnvironment() },
    )
    const records = parseManagedContainers(output)
    for (const record of records) {
      if (record.labels['dsh-phalanx.community'] !== '1' || record.labels['dsh-phalanx.community-root'] !== this.ownership)
        throw new Error('Container ownership listing is inconsistent')
    }
    return records
  }
  async rebuild(hostnames?: ContainerHostnames): Promise<readonly string[]> {
    const container = this.container
    if (!container) return []
    const removed: string[] = []
    for (const record of await this.ownedRecords()) {
      const username = record.labels['dsh-phalanx.user'],
        spaceId = record.labels['dsh-phalanx.space']
      if (hostnames && username && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(username) && spaceId && /^[a-f0-9]{32}$/u.test(spaceId)) {
        const hostname = (await execFileText(container.runtime, ['inspect', '--format', '{{.Config.Hostname}}', record.name])).trim()
        await hostnames.remember({ username, spaceId }, hostname)
      }
      await this.remove(record.name)
      removed.push(record.name)
    }
    return removed
  }
  /** Capture while the predecessor rootless mounts are still reachable. */
  async captureLegacyProfileWriters(): Promise<readonly LegacyProfileWriterHandoff[]> {
    const container = this.container
    if (!container || !this.existingHome) return []
    const captured: LegacyProfileWriterHandoff[] = []
    for (const record of await this.ownedRecords()) {
      const id = record.id,
        username = record.labels['dsh-phalanx.user'],
        spaceId = record.labels['dsh-phalanx.space']
      if (!record.running || !id || !/^[a-f0-9]{64}$/u.test(id) || !username || !spaceId || record.labels[PROFILE_WRITER_HOME_LABEL]) continue
      const home = await this.existingHome(username, spaceId).catch(() => undefined)
      if (!home) continue
      const proof = await liveLegacyProfileWriter(container.runtime, id, home)
      if (proof) captured.push({ record, home, proof })
    }
    return captured
  }
  /** Finish only the same captured generation after the old platform stops admitting work. */
  async recoverLegacyProfileWriters(captured: readonly LegacyProfileWriterHandoff[]): Promise<void> {
    const container = this.container
    if (!container || captured.length === 0) return
    const records = await this.ownedRecords()
    for (const { record, home, proof } of captured) {
      const current = records.find(row => row.id === record.id && row.name === record.name)
      if (
        !current?.id ||
        current.labels[PROFILE_WRITER_HOME_LABEL] ||
        current.labels['dsh-phalanx.user'] !== record.labels['dsh-phalanx.user'] ||
        current.labels['dsh-phalanx.space'] !== record.labels['dsh-phalanx.space']
      )
        continue
      const id = current.id
      await withProfileWriterAdmission(home, async ({ active }) => {
        if (current.running) await this.stopContainer(container.runtime, id)
        const result = active
          ? 'active'
          : await recoverMemberProfileWriteLock(home, lock => exitedContainerLockEvidence(container.runtime, id, home, lock, undefined, undefined, proof))
        this.logLockRecovery(result)
      })
    }
  }
  /** Give confirmed members their exit grace while the predecessor still owns its mounts. */
  async stopPredecessorMembers(): Promise<void> {
    const container = this.container
    if (!container) return
    for (const record of await this.ownedRecords()) {
      if (record.running && record.id && /^[a-f0-9]{64}$/u.test(record.id)) await this.stopContainer(container.runtime, record.id)
    }
  }
  private stopContainer(runtime: string, id: string): Promise<string> {
    // Podman sends the normal stop signal and only escalates after its grace period.
    const seconds = Math.max(1, Math.ceil(this.shutdownTimeoutMs / 1000))
    return execFileText(runtime, ['stop', '--time', String(seconds), '--ignore', id], { env: containerClientEnvironment(), timeout: (seconds + 5) * 1000 })
  }
  private logLockRecovery(result: string): void {
    if (result === 'recovered') console.info('Recovered member profile write lock from an exited container')
    else if (result !== 'absent') console.warn(`Retained member profile write lock (${result})`)
  }
  async assertCarrier(instance: CommunityUserInstance, timeout?: number): Promise<void> {
    const container = this.container
    if (!container || !instance.containerName) throw new Error('Container runtime is unavailable')
    const value = await execFileText(
      container.runtime,
      ['inspect', '--format', '{{.State.Running}} {{.State.Pid}} {{index .Config.Labels "dsh-phalanx.community-root"}}', instance.containerName],
      { env: containerClientEnvironment(), ...(timeout ? { timeout } : {}) },
    )
    if (value.trim() !== `true ${instance.processId} ${this.ownership}`) throw new Error('Member container identity changed')
  }
  async runningNames(): Promise<ReadonlySet<string>> {
    const container = this.container
    if (!container) throw new Error('Container runtime is unavailable')
    const output = await execFileText(container.runtime, [
      'ps',
      '--filter',
      'status=running',
      '--filter',
      'label=dsh-phalanx.community=1',
      '--filter',
      `label=dsh-phalanx.community-root=${this.ownership}`,
      '--format',
      '{{.Names}}',
    ])
    return new Set(output.split('\n').map(name => name.trim()))
  }
  async assertProfileWriterAvailable(home: string): Promise<void> {
    if (!this.container) return
    await withProfileWriterAdmission(home, async ({ active }) => {
      try {
        if (active && profileLockDispositionPending(home)) throw new Error('Member profile recovery has not finished')
        if (!active) restoreInterruptedProfileLock(home)
        readProfileLock(home)
      } catch (error) {
        if (error instanceof CommunityRuntimeUnavailableError) throw error
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      }
      console.warn('Retained member profile write lock without confirmed predecessor evidence')
      throw new CommunityRuntimeUnavailableError('startup-unavailable', 'The member profile is waiting for its existing writer lock')
    })
  }
  async launchMember(
    home: string,
    input: Parameters<typeof buildCommunityContainerLaunchCommand>[0],
    timeout: number,
    remember: (name: string) => void,
  ): Promise<string> {
    const container = this.container
    if (!container) throw new Error('Container runtime is unavailable')
    return withProfileWriterAdmission(home, async ({ active, revision }) => {
      const identity = active ? undefined : await unclaimedProfileWriterHome(container.runtime, home)
      const profileWriterHome = identity && revision ? `${identity}/${revision}` : undefined
      const plan = buildCommunityContainerLaunchCommand({ ...input, ...(profileWriterHome ? { profileWriterHome } : {}) })
      remember(plan.containerName)
      await execFileText(plan.command, plan.args, { env: { ...containerClientEnvironment(), ...plan.passthroughEnvironment }, timeout })
      return plan.containerName
    })
  }
  async remove(name: string, expected?: Pick<CommunityUserInstance, 'userId' | 'spaceId'> & { readonly home?: string | undefined }): Promise<void> {
    const container = this.container
    if (!container) throw new Error('Container runtime is unavailable')
    if (!/^[a-zA-Z0-9_-]+$/u.test(name)) throw new Error('Invalid owned user container name')
    const env = containerClientEnvironment()
    const list = ['ps', '--all', '--no-trunc', '--filter', `name=^${name}$`, '--format', 'json']
    const records = parseManagedContainers(await execFileText(container.runtime, list, { env }))
    if (records.length === 0) return
    const record = records[0]!
    const labels = record.labels
    if (
      records.length !== 1 ||
      record.name !== name ||
      !record.id ||
      !/^[a-f0-9]{64}$/u.test(record.id) ||
      labels['dsh-phalanx.community'] !== '1' ||
      labels['dsh-phalanx.community-root'] !== this.ownership ||
      (expected && (labels['dsh-phalanx.user'] !== expected.userId || labels['dsh-phalanx.space'] !== expected.spaceId))
    )
      throw new Error('Container ownership could not be confirmed before stopping')
    const username = labels['dsh-phalanx.user']
    const spaceId = labels['dsh-phalanx.space']
    const home = expected?.home ?? (username && spaceId ? await this.existingHome?.(username, spaceId).catch(() => undefined) : undefined)
    const id = record.id
    const stop = () => this.stopContainer(container.runtime, id)
    if (home)
      await withProfileWriterAdmission(home, async ({ active, revision }) => {
        const claim = labels[PROFILE_WRITER_HOME_LABEL]
        const legacy = !active && record.running && !claim ? await liveLegacyProfileWriter(container.runtime, id, home) : undefined
        await stop()
        const result = active
          ? 'active'
          : await recoverMemberProfileWriteLock(home, lock => exitedContainerLockEvidence(container.runtime, id, home, lock, claim, revision, legacy))
        this.logLockRecovery(result)
      })
    else await stop()
    await execFileText(container.runtime, ['rm', '--ignore', id], { env })
    if (parseManagedContainers(await execFileText(container.runtime, list, { env })).length) throw new Error('Owned user container remains after removal')
  }
}
