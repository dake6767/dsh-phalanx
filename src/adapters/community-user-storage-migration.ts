import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { CommunityUserStorageMigrationPort, CommunityUserStorageMigrationResult } from '../ports/community-user-storage-migration.js'
import type { CommunityRuntimeDriverPort } from '../ports/community-runtime-driver.js'
import { PlatformLock } from './platform-lock.js'
import { assertOwnedDirectory, assertPrivateFile, atomicPrivateFile, UserStorageBindingMigration, UserStorageGuard } from './user-storage-guard.js'
import { copyUserStorage, userStorageInventory } from './user-storage-copy.js'

interface Receipt {
  readonly version: 1
  readonly id: string
  readonly source: string
  readonly target: string
  readonly mount: string
  readonly stage: string
  readonly previousBinding: string | null
  readonly mountIdentity: string
  readonly phase: 'pending' | 'verified' | 'complete'
}

/** Explicit offline copying; source data and the old binding are retained for recovery. */
export class FileCommunityUserStorageMigration implements CommunityUserStorageMigrationPort {
  private lock: PlatformLock | undefined
  private binding: UserStorageBindingMigration | undefined
  private receipt: Receipt | undefined
  private receiptPath: string | undefined
  constructor(private readonly config: CommunityRuntimeConfig, private readonly runtime: Pick<CommunityRuntimeDriverPort, 'rebuild'>) {}

  async prepare(targetRoot: string, targetMount: string) {
    const dataRoot = resolve(this.config.dataRoot)
    assertOwnedDirectory(dataRoot)
    this.lock = new PlatformLock(dataRoot)
    if (this.config.container === undefined) throw new Error('Offline storage migration requires Linux container deployment')
    const source = resolve(this.config.userDataRoot ?? join(dataRoot, 'users'))
    const target = resolve(targetRoot), mount = resolve(targetMount)
    if (source !== target && (source.startsWith(`${target}${sep}`) || target.startsWith(`${source}${sep}`))) throw new Error('Source and target storage must not overlap')
    this.binding = new UserStorageBindingMigration(dataRoot, target, mount)
    const records = join(dataRoot, 'storage-migrations')
    mkdirSync(records, { recursive: true, mode: 0o700 }); assertOwnedDirectory(records)
    const key = createHash('sha256').update(target).digest('hex')
    this.receiptPath = join(records, `${key}.json`)
    if (existsSync(this.receiptPath)) {
      assertPrivateFile(this.receiptPath)
      const receipt = JSON.parse(readFileSync(this.receiptPath, 'utf8')) as Receipt
      if (receipt.version !== 1 || !/^[a-f0-9]{32}$/u.test(receipt.id) || receipt.target !== target || receipt.mount !== mount
        || receipt.mountIdentity !== this.binding.mount || receipt.stage !== join(dirname(target), `.dsh-phalanx-migration-${receipt.id}`)
        || !['pending', 'verified', 'complete'].includes(receipt.phase) || ![receipt.source, target].includes(source)
        || (receipt.previousBinding !== null && typeof receipt.previousBinding !== 'string')) throw new Error('Invalid migration receipt; restore private metadata before retrying')
      this.receipt = receipt
      if (receipt.phase === 'complete') {
        new UserStorageGuard(dataRoot, target, true, mount).assertAvailable()
        return { state: 'complete' as const, result: this.result() }
      }
      if (source !== receipt.source) throw new Error('Resume incomplete migration using the original protected configuration')
      if (receipt.phase === 'pending') new UserStorageGuard(dataRoot, this.config.userDataRoot, true, this.config.userDataMount).assertAvailable()
    } else {
      if (source === target) throw new Error('Source and target storage must differ')
      new UserStorageGuard(dataRoot, this.config.userDataRoot, true, this.config.userDataMount).assertAvailable()
      assertOwnedDirectory(target)
      if (readdirSync(target).length !== 0) throw new Error('Migration target must already exist and be empty')
      const bindingPath = join(dataRoot, 'user-storage.json')
      if (existsSync(bindingPath)) assertPrivateFile(bindingPath)
      const id = randomBytes(16).toString('hex')
      this.receipt = { version: 1, id, source, target, mount, stage: join(dirname(target), `.dsh-phalanx-migration-${id}`),
        previousBinding: existsSync(bindingPath) ? readFileSync(bindingPath, 'utf8') : null, mountIdentity: this.binding.mount, phase: 'pending' }
      this.save(this.receipt)
      atomicPrivateFile(this.recoveryPath(), this.recoveryInstructions())
    }
    assertOwnedDirectory(this.receipt.source)
    if (realpathSync(this.receipt.source) !== this.receipt.source) throw new Error('Migration source parents must not be symbolic links')
    return { state: 'pending' as const }
  }

  async stopCarriers(): Promise<void> { await this.runtime.rebuild() }
  async copy(): Promise<void> {
    const receipt = this.current()
    if (receipt.phase === 'verified') return
    this.assertMount()
    assertOwnedDirectory(receipt.target)
    if (readdirSync(receipt.target).length !== 0) throw new Error('Migration target changed; retain it and restore the original empty target before retrying')
    userStorageInventory(receipt.source)
    if (existsSync(receipt.stage)) { assertOwnedDirectory(receipt.stage); rmSync(receipt.stage, { recursive: true }) }
    copyUserStorage(receipt.source, receipt.stage)
  }
  async verify(): Promise<void> {
    const receipt = this.current(); this.assertMount()
    const copy = existsSync(receipt.stage) ? receipt.stage : receipt.phase === 'verified' ? receipt.target : undefined
    if (copy === undefined) throw new Error('Migration copy is missing; retry copying from the retained source')
    assertOwnedDirectory(copy)
    if (userStorageInventory(receipt.source) !== userStorageInventory(copy)) throw new Error('Migration verification failed; retained source remains authoritative')
    this.save({ ...receipt, phase: 'verified' })
  }
  async publish(): Promise<CommunityUserStorageMigrationResult> {
    const receipt = this.current()
    if (receipt.phase !== 'verified') throw new Error('Migration must be verified before switching storage')
    this.assertMount()
    if (existsSync(receipt.stage)) {
      assertOwnedDirectory(receipt.target)
      if (readdirSync(receipt.target).length !== 0) throw new Error('Migration target changed after verification')
      // POSIX rename replaces only the previously verified empty directory.
      renameSync(receipt.stage, receipt.target)
    }
    this.binding!.publish(receipt.id)
    this.save({ ...receipt, phase: 'complete' })
    return this.result()
  }
  async close(): Promise<void> { this.lock?.close(); this.lock = undefined }
  private current(): Receipt { if (this.receipt === undefined) throw new Error('Migration has not been prepared'); return this.receipt }
  private save(receipt: Receipt): void { atomicPrivateFile(this.receiptPath!, JSON.stringify(receipt)); this.receipt = receipt }
  private assertMount(): void {
    const receipt = this.current()
    const fresh = new UserStorageBindingMigration(this.config.dataRoot, receipt.target, receipt.mount)
    if (fresh.mount !== receipt.mountIdentity) throw new Error('Migration mount changed; restore the original mounted volume')
  }
  private recoveryPath(): string { return `${this.receiptPath!}.README.txt` }
  private result(): CommunityUserStorageMigrationResult {
    const receipt = this.current()
    return { sourceRoot: receipt.source, targetRoot: receipt.target, targetMount: receipt.mount, recovery: this.recoveryPath() }
  }
  private recoveryInstructions(): string {
    const receipt = this.current()
    return `Offline storage migration\nSource retained: ${receipt.source}\nDestination: ${receipt.target}\nMount: ${receipt.mount}\nReceipt: ${this.receiptPath!}\n\nAfter success, change only DSH_PHALANX_USER_DATA_ROOT and DSH_PHALANX_USER_DATA_MOUNT in the protected service environment to the destination and mount above, then restart. Keep the same platform data root, account database, session secret and model credentials.\n\nTo retry interrupted copying, keep the service stopped, use the original environment and rerun the identical command. A completed receipt does not recopy or overwrite later destination changes.\n\nTo roll back, stop the platform AND confirm all its user containers are removed. Preserve any files written on the destination after cutover before returning to the source. Restore the protected environment backup. Restore user-storage.json from this receipt's previousBinding string (or remove only that binding if previousBinding is null). Do not remove user-storage-identity, source data or destination data. If the source was external, restore its original mount. Restart and verify the original files before reopening access. Retain this receipt; remove it from the active storage-migrations directory only when deliberately beginning a new migration to this destination, after preserving a private copy.\n`
  }
}
