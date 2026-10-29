import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { sameUserStorageBinding, UserStorageBindingChanged, type UserStorageRecord } from '../domain/user-storage.js'
import type { UserStorageFacts, UserStorageMaintenance } from '../ports/user-storage-facts.js'
import type { CommunityUserStorageMigrationPort, CommunityUserStorageMigrationResult } from '../ports/community-user-storage-migration.js'
import type { CommunityRuntimeDriverPort } from '../ports/community-runtime-driver.js'
import { PlatformLock } from './platform-lock.js'
import { assertOwnedDirectory, assertPrivateFile, atomicPrivateFile, mountIdentity, readStorageMarker } from './user-storage-files.js'
import { UserStorageBindingMigration, UserStorageGuard } from './user-storage-guard.js'
import { copyUserStorage, userStorageInventory } from './user-storage-copy.js'
import { effectiveUserDataRoot } from '../domain/storage-layout.js'

interface Receipt {
  readonly version: 2
  readonly id: string
  readonly source: string
  readonly target: string
  readonly mount: string
  readonly stage: string
  readonly previous: UserStorageRecord
  readonly mountIdentity: string
  readonly phase: 'pending' | 'verified' | 'complete' | 'rolled-back'
  readonly publishedRevision?: number
  readonly rollbackRevision?: number
}

/** Files are prepared outside SQL; a private operator receipt binds each publication and rollback to its revision. */
export class FileCommunityUserStorageMigration implements CommunityUserStorageMigrationPort {
  private lock: PlatformLock | undefined
  private facts: UserStorageFacts | undefined
  private binding: UserStorageBindingMigration | undefined
  private receipt: Receipt | undefined
  private receiptPath: string | undefined
  private rollingBack = false
  constructor(
    private readonly config: CommunityRuntimeConfig,
    private readonly runtime: Pick<CommunityRuntimeDriverPort, 'rebuild'>,
    private readonly maintenance: UserStorageMaintenance,
    private readonly recordsDirectory: string,
  ) {}
  async prepare(targetRoot: string, targetMount: string, direction: 'forward' | 'rollback' = 'forward') {
    if (this.lock) throw new Error('A storage migration is already open')
    const dataRoot = resolve(this.config.dataRoot)
    assertOwnedDirectory(dataRoot)
    this.lock = new PlatformLock(dataRoot)
    this.rollingBack = direction === 'rollback'
    this.receipt = undefined
    if (this.config.container === undefined) throw new Error('Offline storage migration requires Linux container deployment')
    this.facts = await this.maintenance.open()
    const source = effectiveUserDataRoot(this.config)
    const target = resolve(targetRoot),
      mount = resolve(targetMount)
    if (source !== target && (source.startsWith(`${target}${sep}`) || target.startsWith(`${source}${sep}`)))
      throw new Error('Source and target storage must not overlap')
    this.binding = new UserStorageBindingMigration(dataRoot, target, mount, this.facts)
    mkdirSync(this.recordsDirectory, { recursive: true, mode: 0o700 })
    assertOwnedDirectory(this.recordsDirectory)
    this.receiptPath = join(this.recordsDirectory, createHash('sha256').update(target).digest('hex') + '.json')
    if (existsSync(this.receiptPath)) {
      assertPrivateFile(this.receiptPath)
      const receipt = JSON.parse(readFileSync(this.receiptPath, 'utf8')) as Receipt
      this.validateReceipt(receipt, source, target, mount)
      this.receipt = receipt
      const current = await this.facts.read()
      if (!current || current.owner !== receipt.previous.owner) throw new UserStorageBindingChanged()
      if (this.rollingBack) {
        if (receipt.phase === 'rolled-back') {
          this.assertRolledBack(current)
          this.assertRetainedSource()
          return { state: 'complete' as const, result: this.result() }
        }
        const publishedRevision = receipt.publishedRevision ?? receipt.previous.revision + 1
        if (receipt.phase !== 'pending' && current.revision === publishedRevision + 1 && sameUserStorageBinding(current.binding, receipt.previous.binding)) {
          this.assertRetainedSource()
          this.save({ ...receipt, phase: 'rolled-back', publishedRevision, rollbackRevision: current.revision })
          return { state: 'complete' as const, result: this.result() }
        }
        if (receipt.phase === 'pending' || !this.isPublished(current)) throw new Error('Only a published storage migration can be rolled back')
        this.assertRetainedSource()
        return { state: 'pending' as const }
      }
      if (receipt.phase === 'rolled-back')
        throw new Error('This migration was rolled back; preserve its receipt before deliberately starting another migration')
      if (receipt.phase === 'complete') {
        if (!this.isPublished(current)) throw new UserStorageBindingChanged()
        await this.assertGuard(target, mount)
        return { state: 'complete' as const, result: this.result() }
      }
      if (source !== receipt.source) throw new Error('Resume incomplete migration using the original protected configuration')
      const original = current.revision === receipt.previous.revision && sameUserStorageBinding(current.binding, receipt.previous.binding)
      if (!original && !(receipt.phase === 'verified' && this.isPublished(current))) throw new UserStorageBindingChanged()
      if (receipt.phase === 'pending') await this.assertGuard(this.config.userDataRoot, this.config.userDataMount)
    } else {
      if (this.rollingBack) throw new Error('The original private migration receipt is required for rollback')
      if (source === target) throw new Error('Source and target storage must differ')
      await this.assertGuard(this.config.userDataRoot, this.config.userDataMount)
      assertOwnedDirectory(target)
      if (readdirSync(target).length !== 0) throw new Error('Migration target must already exist and be empty')
      const previous = await this.facts.read()
      if (!previous) throw new Error('Platform storage identity is missing')
      const id = randomBytes(16).toString('hex')
      this.save({
        version: 2,
        id,
        source,
        target,
        mount,
        stage: join(dirname(target), `.dsh-phalanx-migration-${id}`),
        previous,
        mountIdentity: this.binding.mount,
        phase: 'pending',
      })
      atomicPrivateFile(this.recoveryPath(), this.recoveryInstructions())
    }
    assertOwnedDirectory(this.current().source)
    if (realpathSync(this.current().source) !== this.current().source) throw new Error('Migration source parents must not be symbolic links')
    return { state: 'pending' as const }
  }
  async stopCarriers(): Promise<void> {
    await this.runtime.rebuild()
  }
  async copy(): Promise<void> {
    const receipt = this.current()
    if (receipt.phase === 'verified') return
    this.assertMount()
    assertOwnedDirectory(receipt.target)
    if (readdirSync(receipt.target).length !== 0) throw new Error('Migration target changed; retain it and restore the original empty target before retrying')
    userStorageInventory(receipt.source)
    if (existsSync(receipt.stage)) {
      assertOwnedDirectory(receipt.stage)
      rmSync(receipt.stage, { recursive: true })
    }
    copyUserStorage(receipt.source, receipt.stage)
  }
  async verify(): Promise<void> {
    const receipt = this.current()
    this.assertMount()
    if (receipt.phase === 'verified' && !existsSync(receipt.stage) && this.binding!.hasPublishedMarker(receipt.id, receipt.previous.owner)) return
    const copy = existsSync(receipt.stage) ? receipt.stage : receipt.phase === 'verified' ? receipt.target : undefined
    if (!copy) throw new Error('Migration copy is missing; retry copying from the retained source')
    assertOwnedDirectory(copy)
    if (userStorageInventory(receipt.source) !== userStorageInventory(copy))
      throw new Error('Migration verification failed; retained source remains authoritative')
    this.save({ ...receipt, phase: 'verified' })
  }
  async publish(): Promise<CommunityUserStorageMigrationResult> {
    const receipt = this.current()
    if (receipt.phase !== 'verified') throw new Error('Migration must be verified before switching storage')
    this.assertMount()
    if (existsSync(receipt.stage)) {
      assertOwnedDirectory(receipt.target)
      if (readdirSync(receipt.target).length !== 0) throw new Error('Migration target changed after verification')
      renameSync(receipt.stage, receipt.target)
    }
    const published = await this.binding!.publish(receipt.id, receipt.previous)
    this.save({ ...receipt, phase: 'complete', publishedRevision: published.revision })
    return this.result()
  }
  async rollback(): Promise<CommunityUserStorageMigrationResult> {
    const receipt = this.current(),
      current = await this.facts!.read()
    if (!current || current.owner !== receipt.previous.owner) throw new UserStorageBindingChanged()
    this.assertRetainedSource()
    const publishedRevision = receipt.publishedRevision ?? receipt.previous.revision + 1
    if (current.revision === publishedRevision + 1 && sameUserStorageBinding(current.binding, receipt.previous.binding)) {
      this.save({ ...receipt, phase: 'rolled-back', publishedRevision, rollbackRevision: current.revision })
      return this.result()
    }
    if (!this.isPublished(current) || !this.binding!.hasPublishedMarker(receipt.id, current.owner)) throw new UserStorageBindingChanged()
    const restored = await this.facts!.saveBinding(current.revision, receipt.previous.binding)
    this.save({ ...receipt, phase: 'rolled-back', publishedRevision, rollbackRevision: restored.revision })
    return this.result()
  }
  async close(): Promise<void> {
    try {
      await this.maintenance.close()
    } finally {
      this.facts = undefined
      this.lock?.close()
      this.lock = undefined
    }
  }
  private current(): Receipt {
    if (!this.receipt) throw new Error('Migration has not been prepared')
    return this.receipt
  }
  private save(receipt: Receipt): void {
    atomicPrivateFile(this.receiptPath!, JSON.stringify(receipt))
    this.receipt = receipt
  }
  private assertMount(): void {
    const receipt = this.current()
    const fresh = new UserStorageBindingMigration(this.config.dataRoot, receipt.target, receipt.mount, this.facts!)
    if (fresh.mount !== receipt.mountIdentity) throw new Error('Migration mount changed; restore the original mounted volume')
  }
  private async assertGuard(root: string | undefined, mount: string | undefined): Promise<void> {
    const guard = new UserStorageGuard(this.config.dataRoot, this.facts!, root, true, mount)
    await guard.initialize()
    await guard.assertAvailable()
  }
  private isPublished(current: UserStorageRecord): boolean {
    const receipt = this.current()
    return (
      current.revision === (receipt.publishedRevision ?? receipt.previous.revision + 1) &&
      sameUserStorageBinding(current.binding, { path: receipt.target, id: receipt.id, mount: receipt.mountIdentity })
    )
  }
  private assertRolledBack(current: UserStorageRecord): void {
    const receipt = this.current()
    if (current.revision !== receipt.rollbackRevision || !sameUserStorageBinding(current.binding, receipt.previous.binding))
      throw new UserStorageBindingChanged()
  }
  private assertRetainedSource(): void {
    const receipt = this.current(),
      previous = receipt.previous
    assertOwnedDirectory(receipt.source)
    if (realpathSync(receipt.source) !== receipt.source) throw new Error('Migration source parents must not be symbolic links')
    if (!previous.binding) {
      if (receipt.source !== effectiveUserDataRoot({ dataRoot: this.config.dataRoot })) throw new Error('Original default user storage changed')
      return
    }
    const marker = readStorageMarker(join(receipt.source, '.dsh-phalanx-storage.json'))
    if (marker.owner !== previous.owner || marker.id !== previous.binding.id || previous.binding.path !== receipt.source)
      throw new Error('Original user storage identity changed')
    const mount = JSON.parse(previous.binding.mount) as { path: string }
    if (mountIdentity(receipt.source, true, mount.path) !== previous.binding.mount) throw new Error('Original user storage mount changed')
  }
  private validateReceipt(receipt: Receipt, source: string, target: string, mount: string): void {
    if (
      !receipt ||
      receipt.version !== 2 ||
      typeof receipt.source !== 'string' ||
      resolve(receipt.source) !== receipt.source ||
      !/^[a-f0-9]{32}$/u.test(receipt.id) ||
      receipt.target !== target ||
      receipt.mount !== mount ||
      receipt.mountIdentity !== this.binding!.mount ||
      receipt.stage !== join(dirname(target), `.dsh-phalanx-migration-${receipt.id}`) ||
      !['pending', 'verified', 'complete', 'rolled-back'].includes(receipt.phase) ||
      ![receipt.source, target].includes(source) ||
      !validRecord(receipt.previous) ||
      (receipt.previous.binding && receipt.previous.binding.path !== receipt.source) ||
      (receipt.publishedRevision !== undefined && receipt.publishedRevision !== receipt.previous.revision + 1) ||
      (receipt.rollbackRevision !== undefined && receipt.rollbackRevision !== receipt.previous.revision + 2) ||
      (receipt.phase === 'complete' && receipt.publishedRevision === undefined) ||
      (receipt.phase === 'rolled-back' &&
        (receipt.publishedRevision !== receipt.previous.revision + 1 || receipt.rollbackRevision !== receipt.publishedRevision + 1))
    )
      throw new Error('Invalid migration receipt; restore private metadata before retrying')
  }
  private recoveryPath(): string {
    return this.receiptPath! + '.README.txt'
  }
  private result(): CommunityUserStorageMigrationResult {
    const receipt = this.current()
    return this.rollingBack
      ? {
          sourceRoot: receipt.target,
          targetRoot: receipt.source,
          targetMount: receipt.previous.binding ? (JSON.parse(receipt.previous.binding.mount) as { path: string }).path : null,
          recovery: this.recoveryPath(),
          direction: 'rollback',
        }
      : { sourceRoot: receipt.source, targetRoot: receipt.target, targetMount: receipt.mount, recovery: this.recoveryPath() }
  }
  private recoveryInstructions(): string {
    const receipt = this.current()
    return `Offline storage migration\nSource retained: ${receipt.source}\nDestination: ${receipt.target}\nMount: ${receipt.mount}\nReceipt: ${this.receiptPath!}\n\nAfter success, change only DSH_PHALANX_USER_DATA_ROOT and DSH_PHALANX_USER_DATA_MOUNT in the protected service environment to the destination and mount above, then restart. Keep the same platform database, master key and session/model configuration.\n\nTo resume, keep the service stopped, use the original protected environment and rerun the identical command. A verified marker after rename resumes only SQL publication. A completed receipt does not recopy or overwrite later destination changes.\n\nTo roll back, stop the platform and preserve any new destination files separately. As the configuration owner run the same migrate-user-storage command with --rollback --target-root ${shellArgument(receipt.target)} --mount ${shellArgument(receipt.mount)}. It stops owned carriers, validates the retained original source and restores only the previous SQL binding with a revision check; later storage changes are rejected. Restore the original protected environment backup before restarting. If targetMount in the rollback result is null, remove the two explicit USER_DATA settings instead of turning the default root into an external mount. Do not delete the owner identity, source, destination or this receipt. A rolled-back receipt may be archived privately only when deliberately starting a new migration to the same destination.\n`
  }
}
function validRecord(value: unknown): value is UserStorageRecord {
  if (!value || typeof value !== 'object') return false
  const row = value as UserStorageRecord,
    binding = row.binding
  return (
    typeof row.owner === 'string' &&
    /^[a-f0-9]{32}$/u.test(row.owner) &&
    Number.isSafeInteger(row.revision) &&
    row.revision >= 0 &&
    (binding === null ||
      (!!binding &&
        typeof binding.path === 'string' &&
        typeof binding.mount === 'string' &&
        typeof binding.id === 'string' &&
        /^[a-f0-9]{32}$/u.test(binding.id)))
  )
}

function shellArgument(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}
