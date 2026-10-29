import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { FilePlatformSecrets } from '../src/adapters/platform-secrets.js'
import { PostgresSystemStatus } from '../src/adapters/postgres-system-status.js'
import { postgresConnection } from './support/postgres.js'

it('shares backup acknowledgement across administrators and restarts, rejects a stale fingerprint and hides an old-key acknowledgement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'system-status-')),
    masterKeyPath = join(root, 'master.key')
  const secrets = FilePlatformSecrets.create(masterKeyPath),
    registry = secrets.registry()
  secrets.close()
  const connection = postgresConnection(),
    security = { masterKeyPath, registry }
  let database = new PlatformDatabase(connection, security)
  try {
    await database.initialize()
    const status = new PostgresSystemStatus(database, () => 'external')
    const initial = await status.read()
    expect(initial).toEqual({
      database: {
        kind: 'external',
        address: `${connection.host}:${connection.port}/${connection.database}`,
        serverVersion: expect.any(String),
        state: 'connected',
      },
      masterKey: { fingerprint: registry.masterFingerprint, backup: null },
    })
    const confirmed = await status.confirmBackup(registry.masterFingerprint, { username: 'first-admin', spaceId: 'first-space' })
    expect(confirmed.masterKey.backup).toEqual({ username: 'first-admin', spaceId: 'first-space', confirmedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/u) })
    expect(JSON.stringify(confirmed)).not.toContain(connection.password)
    await database.close()
    database = new PlatformDatabase(connection, security)
    await database.initialize()
    const other = new PostgresSystemStatus(database, () => 'builtin')
    expect((await other.read()).masterKey).toEqual(confirmed.masterKey)
    await expect(other.confirmBackup(`sha256:${'f'.repeat(64)}`, { username: 'second-admin', spaceId: 'second-space' })).rejects.toMatchObject({
      code: 'master-key-changed',
    })
    expect((await other.read()).masterKey).toEqual(confirmed.masterKey)
    // The registry's current fingerprint is the public fact used by key operations.
    await database.query("UPDATE dsh_phalanx.platform_security SET registry=jsonb_set(registry,'{masterFingerprint}',to_jsonb($1::text)) WHERE id=1", [
      `sha256:${'b'.repeat(64)}`,
    ])
    expect((await other.read()).masterKey).toEqual({ fingerprint: `sha256:${'b'.repeat(64)}`, backup: null })
  } finally {
    await database.close()
    rmSync(root, { recursive: true, force: true })
  }
})
