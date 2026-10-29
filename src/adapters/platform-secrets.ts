import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PlatformSecretContext, PlatformSecretEnvelope, PlatformSecretRegistry } from '../domain/platform-secret.js'

/** The only owner of platform master keys, envelope wrapping and field crypto. */
export class FilePlatformSecrets {
  private readonly keys = new Map<string, Buffer>()
  private closed = false
  private constructor(
    private readonly master: Buffer,
    private readonly saved: PlatformSecretRegistry,
  ) {
    try {
      for (const key of saved.keys) {
        const value = decrypt(this.master, wrappingContext(key.key_id), key)
        if (value.length !== 32) {
          value.fill(0)
          throw Error(`Invalid platform data key ${key.key_id}`)
        }
        this.keys.set(key.key_id, value)
      }
    } catch (error) {
      this.close()
      throw error
    }
  }
  static randomCredential(): string {
    return randomBytes(32).toString('base64url')
  }
  static create(path: string): FilePlatformSecrets {
    const master = randomBytes(32),
      id = randomUUID(),
      key = randomBytes(32)
    try {
      const file = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeFileSync(file, master)
        fsyncSync(file)
      } finally {
        closeSync(file)
      }
      const directory = openSync(dirname(path), constants.O_RDONLY)
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
      return new FilePlatformSecrets(master, { version: 1, masterFingerprint: fingerprint(master), keys: [encrypt(master, id, wrappingContext(id), key)] })
    } catch (error) {
      master.fill(0)
      throw error
    } finally {
      key.fill(0)
    }
  }
  static open(path: string, value: unknown): FilePlatformSecrets {
    const registry = keyRegistry(value)
    const master = readMaster(path)
    if (fingerprint(master) !== registry.masterFingerprint) {
      master.fill(0)
      throw Error('Platform master-key fingerprint does not match; restore the matching master-key file')
    }
    return new FilePlatformSecrets(master, structuredClone(registry))
  }
  registry(): PlatformSecretRegistry {
    this.assertOpen()
    return structuredClone(this.saved)
  }
  /** Stage a private new master and registry; the operator commits their durable replacement. */
  rewrap(nextMasterPath: string): PlatformSecretRegistry {
    this.assertOpen()
    const master = randomBytes(32)
    try {
      const registry: PlatformSecretRegistry = {
        version: 1,
        masterFingerprint: fingerprint(master),
        keys: [...this.keys].map(([id, key]) => encrypt(master, id, wrappingContext(id), key)),
      }
      const file = openSync(nextMasterPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeFileSync(file, master)
        fsyncSync(file)
      } finally {
        closeSync(file)
      }
      const directory = openSync(dirname(nextMasterPath), constants.O_RDONLY)
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
      return registry
    } finally {
      master.fill(0)
    }
  }
  /** Rewrap another retained registry with the same already-staged new master. */
  rewrapTo(nextMasterPath: string): PlatformSecretRegistry {
    this.assertOpen()
    const master = readMaster(nextMasterPath)
    try {
      return { version: 1, masterFingerprint: fingerprint(master), keys: [...this.keys].map(([id, key]) => encrypt(master, id, wrappingContext(id), key)) }
    } finally {
      master.fill(0)
    }
  }
  encrypt(context: PlatformSecretContext, value: string): PlatformSecretEnvelope {
    this.assertOpen()
    const id = this.saved.keys[0]!.key_id
    return encrypt(this.keys.get(id)!, id, context, Buffer.from(value))
  }
  decrypt(context: PlatformSecretContext, envelope: PlatformSecretEnvelope): string {
    this.assertOpen()
    const key = this.keys.get(envelope.key_id)
    if (!key) throw Error(`Unknown platform data key for ${context.table}/${context.recordId}/${context.field}`)
    return decrypt(key, context, envelope).toString('utf8')
  }
  close(): void {
    this.master.fill(0)
    for (const key of this.keys.values()) key.fill(0)
    this.keys.clear()
    this.closed = true
  }
  private assertOpen(): void {
    if (this.closed) throw Error('Platform secrets are closed')
  }
}

function fingerprint(key: Buffer): string {
  return 'sha256:' + createHash('sha256').update(key).digest('hex')
}
function keyRegistry(value: unknown): PlatformSecretRegistry {
  const invalid = () => Error('Platform data-key registry is incomplete or invalid')
  if (!value || typeof value !== 'object') throw invalid()
  const input = value as Record<string, unknown>
  if (input.version !== 1 || typeof input.masterFingerprint !== 'string' || !Array.isArray(input.keys) || !input.keys.length) throw invalid()
  const keys = input.keys.map((key: unknown) => {
    if (!key || typeof key !== 'object') throw invalid()
    const row = key as Record<string, unknown>
    if (typeof row.key_id !== 'string' || row.key_id === '' || typeof row.nonce !== 'string' || typeof row.ciphertext !== 'string') throw invalid()
    return { key_id: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext }
  })
  if (new Set(keys.map(key => key.key_id)).size !== keys.length) throw invalid()
  return { version: 1, masterFingerprint: input.masterFingerprint, keys }
}
function readMaster(path: string): Buffer {
  let file: number
  try {
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      throw Error('Platform master-key file is missing; restore it from the offline backup before starting')
    throw error
  }
  try {
    const stat = fstatSync(file)
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw Error('Platform master-key file must be a regular 0600 file')
    if (stat.size !== 32) throw Error('Platform master-key file must contain exactly 256 bits')
    return readFileSync(file)
  } finally {
    closeSync(file)
  }
}
function wrappingContext(id: string): PlatformSecretContext {
  return { table: 'platform_keys', recordId: id, field: 'wrapped_key' }
}
function aad(context: PlatformSecretContext): Buffer {
  return Buffer.from(JSON.stringify([context.table, context.recordId, context.field]))
}
function encrypt(key: Buffer, id: string, context: PlatformSecretContext, value: Buffer): PlatformSecretEnvelope {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(aad(context))
  const body = Buffer.concat([cipher.update(value), cipher.final(), cipher.getAuthTag()])
  return { key_id: id, nonce: nonce.toString('base64url'), ciphertext: body.toString('base64url') }
}
function decrypt(key: Buffer, context: PlatformSecretContext, envelope: PlatformSecretEnvelope): Buffer {
  try {
    const body = Buffer.from(envelope.ciphertext, 'base64url'),
      nonce = Buffer.from(envelope.nonce, 'base64url')
    if (nonce.length !== 12 || body.length < 16) throw Error('Invalid envelope')
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
    decipher.setAAD(aad(context))
    decipher.setAuthTag(body.subarray(-16))
    return Buffer.concat([decipher.update(body.subarray(0, -16)), decipher.final()])
  } catch {
    throw Error(`Cannot decrypt platform secret at ${context.table}/${context.recordId}/${context.field}`)
  }
}
