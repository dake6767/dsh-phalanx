import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { UserStorageRecord } from '../domain/user-storage.js'
import { UserStorageBindingChanged, sameUserStorageBinding } from '../domain/user-storage.js'
import type { UserStorageFacts } from '../ports/user-storage-facts.js'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'
import { durableStorageRoot, effectiveUserDataRoot } from '../domain/storage-layout.js'
import { assertOwnedDirectory, atomicPrivateFile, createStorageMarker, mountIdentity, readStorageMarker } from './user-storage-files.js'

/** Each admission reads current SQL facts; only physical mount inspection has a short cache. */
export class UserStorageGuard {
  private ready = false
  private mountCheck: { identity: string; until: number } | undefined
  constructor(
    private readonly dataRoot: string,
    private readonly facts: UserStorageFacts,
    private readonly userDataRoot?: string,
    private readonly requireMount = false,
    private readonly expectedMount?: string,
  ) {}
  async initialize({ readOnly = false }: { readonly readOnly?: boolean } = {}): Promise<void> {
    this.ready = false
    try {
      assertOwnedDirectory(this.dataRoot)
      let record = await this.facts.read()
      if (readOnly) {
        if (!record) throw new Error('Platform storage identity is missing')
        this.validate(record)
        this.ready = true
        return
      }
      if (this.userDataRoot === undefined) {
        if (this.expectedMount !== undefined) throw new Error('A user data mount requires a user data root')
        if (record?.binding) throw new Error('Configured user storage must not be omitted')
        if (!record) {
          const users = effectiveUserDataRoot({ dataRoot: this.dataRoot })
          for (const path of [durableStorageRoot(this.dataRoot), users]) if (existsSync(path)) assertOwnedDirectory(path)
          for (const previous of [users, join(this.dataRoot, 'users')]) {
            if (existsSync(previous) && readdirSync(previous).length > 0)
              throw new Error('Restore the original platform storage identity before attaching existing user storage')
          }
        }
        record ??= await this.facts.createOwner(randomBytes(16).toString('hex'))
        this.validate(record, false)
        this.ready = true
        return
      }
      assertOwnedDirectory(this.userDataRoot)
      const path = realpathSync(this.userDataRoot),
        platform = realpathSync(this.dataRoot)
      assertSeparate(platform, path)
      const mount = mountIdentity(path, this.requireMount, this.expectedMount)
      const markerPath = join(path, '.dsh-phalanx-storage.json')
      if (!record && existsSync(markerPath)) throw new Error('Restore the original platform storage identity before attaching existing user storage')
      record ??= await this.facts.createOwner(randomBytes(16).toString('hex'))
      if (!record.binding) {
        for (const previous of [effectiveUserDataRoot({ dataRoot: this.dataRoot }), join(this.dataRoot, 'users')]) {
          if (existsSync(previous) && readdirSync(previous).length > 0 && realpathSync(previous) !== path)
            throw new Error('Existing user data requires an explicit storage migration')
        }
        if (!existsSync(markerPath) && readdirSync(path).length > 0)
          throw new Error('New user storage must be empty; existing data requires explicit migration')
        const marker = existsSync(markerPath)
          ? readStorageMarker(markerPath)
          : createStorageMarker(markerPath, { id: randomBytes(16).toString('hex'), owner: record.owner })
        if (marker.owner !== record.owner) throw new Error('User storage belongs to another platform')
        record = await this.facts.saveBinding(record.revision, { path, id: marker.id, mount })
      }
      this.validate(record, false)
      this.ready = true
    } catch (cause) {
      this.mountCheck = undefined
      throw unavailable(cause)
    }
  }
  async assertAvailable(): Promise<void> {
    try {
      if (!this.ready) throw new Error('User storage has not been initialized')
      const record = await this.facts.read()
      if (!record) throw new Error('Platform storage identity is missing')
      this.validate(record)
    } catch (cause) {
      this.mountCheck = undefined
      throw unavailable(cause)
    }
  }
  private validate(record: UserStorageRecord, readOnly = true): void {
    if (this.userDataRoot === undefined) {
      if (record.binding || this.expectedMount !== undefined) throw new Error('Configured user storage must not be omitted')
      const namespace = durableStorageRoot(this.dataRoot),
        users = effectiveUserDataRoot({ dataRoot: this.dataRoot })
      for (const path of [namespace, users]) {
        if (!existsSync(path) && !readOnly) mkdirSync(path, { mode: 0o700 })
        assertOwnedDirectory(path)
      }
      assertSeparate(realpathSync(this.dataRoot), realpathSync(users))
      return
    }
    const binding = record.binding
    if (!binding) throw new Error('User storage binding is missing')
    assertOwnedDirectory(this.userDataRoot)
    const path = realpathSync(this.userDataRoot)
    assertSeparate(realpathSync(this.dataRoot), path)
    const marker = readStorageMarker(join(path, '.dsh-phalanx-storage.json'))
    if (path !== binding.path || this.currentMount(path) !== binding.mount || marker.id !== binding.id || marker.owner !== record.owner)
      throw new Error('User storage identity changed')
  }
  private currentMount(path: string): string {
    const now = performance.now()
    if (this.mountCheck !== undefined && now < this.mountCheck.until) return this.mountCheck.identity
    const identity = mountIdentity(path, this.requireMount, this.expectedMount)
    this.mountCheck = { identity, until: now + 250 }
    return identity
  }
}

/** External marker publication precedes one compare-and-swap of the authoritative SQL binding. */
export class UserStorageBindingMigration {
  readonly path: string
  readonly mount: string
  constructor(
    dataRoot: string,
    target: string,
    expectedMount: string,
    private readonly facts: UserStorageFacts,
  ) {
    assertOwnedDirectory(dataRoot)
    const requested = resolve(target)
    assertOwnedDirectory(dirname(requested))
    if (realpathSync(dirname(requested)) !== dirname(requested)) throw new Error('Migration target parents must not be symbolic links')
    this.path = requested
    assertSeparate(realpathSync(dataRoot), requested)
    if (requested === realpathSync(expectedMount)) throw new Error('Migration target must be a directory below the mounted volume')
    this.mount = mountIdentity(dirname(requested), true, expectedMount)
  }
  hasPublishedMarker(id: string, owner: string): boolean {
    this.assertTarget()
    const path = join(this.path, '.dsh-phalanx-storage.json')
    if (!existsSync(path)) return false
    const marker = readStorageMarker(path)
    if (marker.owner !== owner) throw new Error('User storage belongs to another platform')
    return marker.id === id
  }
  async publish(id: string, previous: UserStorageRecord): Promise<UserStorageRecord> {
    if (!/^[a-f0-9]{32}$/u.test(id)) throw new Error('Invalid migration identity')
    this.assertTarget()
    const current = await this.facts.read()
    if (!current || current.owner !== previous.owner) throw new UserStorageBindingChanged()
    if (current.binding?.path === this.path && current.binding.id === id && current.binding.mount === this.mount) {
      if (current.revision !== previous.revision + 1) throw new UserStorageBindingChanged()
      if (!this.hasPublishedMarker(id, current.owner)) throw new Error('User storage identity changed')
      return current
    }
    if (current.revision !== previous.revision || !sameUserStorageBinding(current.binding, previous.binding)) throw new UserStorageBindingChanged()
    const markerPath = join(this.path, '.dsh-phalanx-storage.json')
    if (existsSync(markerPath)) {
      const marker = readStorageMarker(markerPath)
      if (marker.owner !== current.owner || (marker.id !== id && marker.id !== previous.binding?.id))
        throw new Error('Migration target storage identity changed')
      if (marker.id !== id) atomicPrivateFile(markerPath, JSON.stringify({ id, owner: current.owner }))
    } else createStorageMarker(markerPath, { id, owner: current.owner })
    if (!this.hasPublishedMarker(id, current.owner)) throw new Error('Migration target storage identity changed')
    return await this.facts.saveBinding(previous.revision, { path: this.path, id, mount: this.mount })
  }
  private assertTarget(): void {
    assertOwnedDirectory(this.path)
    if (mountIdentity(this.path, true, JSON.parse(this.mount).path as string) !== this.mount) throw new Error('Migration mount changed')
  }
}
function assertSeparate(platform: string, path: string): void {
  if (path === platform || path.startsWith(`${platform}${sep}`) || platform.startsWith(`${path}${sep}`))
    throw new Error('Platform and external user storage must not overlap')
}
function unavailable(cause: unknown) {
  return new CommunityRuntimeUnavailableError(
    'storage-unavailable',
    'User data storage is unavailable; restore the configured mount, ownership and storage identity before retrying',
    { cause },
  )
}
