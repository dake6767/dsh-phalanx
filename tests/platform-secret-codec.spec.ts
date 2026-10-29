import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { PlatformSecretContext, PlatformSecretEnvelope } from '../src/domain/platform-secret.js'
import { FilePlatformSecrets } from '../src/adapters/platform-secrets.js'
import { protectedTable } from '../src/adapters/platform-secret-codec.js'

const fixtureRoot = 'tests/fixtures/platform-secrets-baseline'
const fixture = JSON.parse(readFileSync(join(fixtureRoot, 'envelopes.json'), 'utf8')) as {
  registry: unknown
  entries: { context: PlatformSecretContext; plaintext: string; envelope: PlatformSecretEnvelope }[]
}
const openFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'secret-codec-')),
    key = join(root, 'master.key')
  writeFileSync(key, Buffer.from(readFileSync(join(fixtureRoot, 'master.key.hex'), 'utf8').trim(), 'hex'), { mode: 0o600 })
  return { secrets: FilePlatformSecrets.open(key, fixture.registry), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

it('decrypts every envelope 0.1.25 wrote, byte for byte, through a declared protected field', () => {
  const { secrets, cleanup } = openFixture()
  try {
    for (const { context, plaintext, envelope } of fixture.entries) {
      expect(protectedTable(context.table).decrypt(secrets, context.recordId, context.field, envelope), context.table).toBe(plaintext)
    }
  } finally {
    secrets.close()
    cleanup()
  }
})

it('binds an envelope to its table, record and field so a moved value fails to decrypt', () => {
  const { secrets, cleanup } = openFixture()
  try {
    const providers = protectedTable('shared_model_providers'),
      envelope = providers.encrypt(secrets, 'provider-a', 'api_key', 'fictional-provider-key')
    expect(providers.decrypt(secrets, 'provider-a', 'api_key', envelope)).toBe('fictional-provider-key')
    expect(() => providers.decrypt(secrets, 'provider-b', 'api_key', envelope)).toThrow(
      'Cannot decrypt platform secret at shared_model_providers/provider-b/api_key',
    )
    expect(() => providers.decrypt(secrets, 'provider-a', 'other', envelope)).toThrow('Cannot decrypt')
    expect(() => protectedTable('model_access_tokens').decrypt(secrets, 'provider-a', 'api_key', envelope)).toThrow('Cannot decrypt')
    expect(JSON.stringify(envelope)).not.toContain('fictional-provider-key')
  } finally {
    secrets.close()
    cleanup()
  }
})

it('composes the same context the stores have always written', () => {
  expect(protectedTable('plugin_upstreams').context(JSON.stringify(['@scope/plugin', 'main']), 'headers/authorization')).toEqual({
    table: 'plugin_upstreams',
    recordId: '["@scope/plugin","main"]',
    field: 'headers/authorization',
  })
  for (const table of ['', 'Upper', 'dsh_phalanx.plugin_upstreams']) expect(() => protectedTable(table)).toThrow('platform table name')
})

it('keeps a baseline envelope for every protected table the stores declare', async () => {
  const { readdir } = await import('node:fs/promises')
  const declared = new Set<string>()
  for (const file of await readdir('src/adapters')) {
    for (const match of readFileSync(join('src/adapters', file), 'utf8').matchAll(/protectedTable\('([a-z_]+)'\)/gu)) declared.add(match[1]!)
  }
  expect([...declared].sort()).toEqual([...new Set(fixture.entries.map(entry => entry.context.table))].sort())
})
