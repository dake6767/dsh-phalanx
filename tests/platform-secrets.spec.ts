import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FilePlatformSecrets } from '../src/adapters/platform-secrets.js'

it('reopens encrypted platform credentials using a private master-key file without persisting their plaintext', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-secrets-')),
    path = join(root, 'master.key')
  try {
    const secrets = FilePlatformSecrets.create(path)
    const context = { table: 'shared_providers', recordId: 'provider-one', field: 'api_key' }
    const envelope = secrets.encrypt(context, 'fictional-provider-credential')
    const registry = secrets.registry()
    expect(secrets.decrypt(context, envelope)).toBe('fictional-provider-credential')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path)).toHaveLength(32)
    expect(JSON.stringify({ registry, envelope })).not.toContain('fictional-provider-credential')
    secrets.close()
    const reopened = FilePlatformSecrets.open(path, registry)
    expect(reopened.decrypt(context, envelope)).toBe('fictional-provider-credential')
    reopened.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses to load a master-key file readable by other users', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-secrets-mode-')),
    path = join(root, 'master.key')
  try {
    const secrets = FilePlatformSecrets.create(path),
      registry = secrets.registry()
    secrets.close()
    chmodSync(path, 0o644)
    expect(() => FilePlatformSecrets.open(path, registry)).toThrow('0600')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('diagnoses a missing master-key file without replacing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-secrets-missing-')),
    path = join(root, 'master.key')
  try {
    const secrets = FilePlatformSecrets.create(path),
      registry = secrets.registry()
    secrets.close()
    unlinkSync(path)
    expect(() => FilePlatformSecrets.open(path, registry)).toThrow('restore')
    expect(existsSync(path)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('authenticates the table, record and field without treating ambiguous path strings as one position', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-secrets-position-')),
    path = join(root, 'master.key')
  const secrets = FilePlatformSecrets.create(path)
  try {
    const context = { table: 'plugin_upstreams', recordId: 'entry/one', field: 'credential' }
    const envelope = secrets.encrypt(context, 'fictional-upstream-credential')
    for (const changed of [
      { ...context, table: 'plugin_access' },
      { ...context, recordId: 'entry/two' },
      { ...context, field: 'headers' },
      { table: 'plugin_upstreams/entry', recordId: 'one', field: 'credential' },
    ]) {
      expect(() => secrets.decrypt(changed, envelope)).toThrow(`Cannot decrypt platform secret at ${changed.table}/${changed.recordId}/${changed.field}`)
    }
    expect(secrets.decrypt(context, envelope)).toBe('fictional-upstream-credential')
  } finally {
    secrets.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('rejects a different master key before opening its persisted key registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-secrets-fingerprint-'))
  try {
    const first = FilePlatformSecrets.create(join(root, 'first.key')),
      second = FilePlatformSecrets.create(join(root, 'second.key'))
    const registry = first.registry()
    first.close()
    second.close()
    expect(() => FilePlatformSecrets.open(join(root, 'second.key'), registry)).toThrow('fingerprint does not match')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses an incomplete persisted data-key registry at startup', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-secrets-registry-')),
    path = join(root, 'master.key')
  try {
    const secrets = FilePlatformSecrets.create(path),
      registry = secrets.registry()
    secrets.close()
    expect(() => FilePlatformSecrets.open(path, { ...registry, keys: [] })).toThrow('registry is incomplete')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('rewraps the existing data keys for a new master without rewriting business ciphertext', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-secrets-rewrap-')),
    oldPath = join(root, 'master.key'),
    nextPath = join(root, 'next.key')
  const original = FilePlatformSecrets.create(oldPath)
  try {
    const context = { table: 'shared_model_providers', recordId: 'provider-one', field: 'api_key' }
    const envelope = original.encrypt(context, 'fictional-rotation-credential'),
      oldRegistry = original.registry(),
      oldKey = readFileSync(oldPath)
    const nextRegistry = original.rewrap(nextPath)
    expect(nextRegistry.masterFingerprint).not.toBe(oldRegistry.masterFingerprint)
    expect(nextRegistry.keys.map(key => key.key_id)).toEqual(oldRegistry.keys.map(key => key.key_id))
    expect(statSync(nextPath).mode & 0o777).toBe(0o600)
    const next = FilePlatformSecrets.open(nextPath, nextRegistry)
    try {
      expect(next.decrypt(context, envelope)).toBe('fictional-rotation-credential')
    } finally {
      next.close()
    }
    expect(() => FilePlatformSecrets.open(oldPath, nextRegistry)).toThrow('fingerprint does not match')
    expect(readFileSync(oldPath)).toEqual(oldKey)
    expect(original.decrypt(context, envelope)).toBe('fictional-rotation-credential')
  } finally {
    original.close()
    rmSync(root, { recursive: true, force: true })
  }
})
