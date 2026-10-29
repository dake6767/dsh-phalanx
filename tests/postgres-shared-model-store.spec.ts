import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresSharedModelStore } from '../src/adapters/postgres-shared-model-store.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { SharedModelAdministration } from '../src/use-cases/shared-model-administration.js'
import { FileSharedModelProjection } from '../src/adapters/shared-model-projection.js'
import type { SharedModelState } from '../src/domain/shared-models.js'
import { openTestDatabase } from './support/community-application.js'

it('reopens shared model settings from PostgreSQL without persisting the provider credential in plaintext', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-shared-models-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const state: SharedModelState = {
    revision: 1,
    defaultModelId: 'chat',
    providers: [
      {
        id: 'provider-one',
        name: 'Shared',
        baseUrl: 'https://models.example.test/anthropic',
        apiFormat: 'anthropic-messages',
        apiKey: 'fictional-provider-credential',
        enabled: true,
        models: [{ id: 'chat', name: 'fixture-chat', enabled: true, input: 'text' }],
      },
    ],
  }
  try {
    const store = new PostgresSharedModelStore(database, new FileSharedModelProjection(root))
    await store.initialize()
    expect(store.read()).toEqual({ revision: 0, defaultModelId: null, providers: [] })
    await store.save(state)
    const rows = await database.query('SELECT * FROM dsh_phalanx.shared_model_providers')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.api_key).toEqual({ key_id: expect.any(String), nonce: expect.any(String), ciphertext: expect.any(String) })
    expect(JSON.stringify(rows)).not.toContain('fictional-provider-credential')
    const reopened = new PostgresSharedModelStore(other, new FileSharedModelProjection(root))
    await reopened.initialize()
    expect(reopened.read()).toEqual(state)
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('publishes the committed model catalog through the official runtime include without projecting its provider key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-model-projection-'))
  const database = await openTestDatabase(root)
  try {
    const store = new PostgresSharedModelStore(database, new FileSharedModelProjection(root))
    await store.initialize()
    await store.save({
      revision: 1,
      defaultModelId: 'chat',
      providers: [
        {
          id: 'provider',
          name: 'Shared',
          baseUrl: 'https://models.example.test/anthropic',
          apiFormat: 'anthropic-messages',
          apiKey: 'fictional-provider-credential',
          enabled: true,
          models: [{ id: 'chat', name: 'fixture-chat', enabled: true, input: 'text' }],
        },
      ],
    })
    const catalog = await readFile(join(root, 'managed-models/catalog.json'), 'utf8')
    expect(JSON.parse(catalog)[0].config.providers['deepseek-official'].models).toEqual([{ id: 'chat', name: 'Shared / fixture-chat', input: ['text'] }])
    expect(catalog).toContain('DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN')
    expect(catalog).not.toContain('fictional-provider-credential')
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('does not complete a model management response while its PostgreSQL save is waiting to commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-model-administration-'))
  const database = await openTestDatabase(root)
  let release!: () => void, pendingWrite: Promise<void> | undefined
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const actor = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const store = new PostgresSharedModelStore(database, new FileSharedModelProjection(root))
    await store.initialize()
    let entered!: () => void,
      completed = false
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    const holder = database.transaction(async sql => {
      await sql.query('SELECT id FROM dsh_phalanx.shared_model_settings WHERE id=1 FOR UPDATE')
      entered()
      await gate
    })
    await began
    const service = new SharedModelAdministration(accounts, {
      read: store.read.bind(store),
      newId: store.newId.bind(store),
      save: next => {
        pendingWrite = store.save(next)
        return pendingWrite
      },
    })
    const saving = service
      .execute(actor, {
        revision: 0,
        action: 'save-provider',
        provider: {
          name: 'Shared',
          baseUrl: 'https://models.example.test/anthropic',
          apiFormat: 'anthropic-messages',
          apiKey: 'fictional-provider-credential',
          enabled: true,
          models: [{ name: 'fixture-chat', enabled: true }],
        },
      })
      .then(result => {
        completed = true
        return result
      })
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await database.query<{ waiting: string }>(
                "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            )[0]!.waiting,
          ),
        )
        .toBeGreaterThan(0)
      expect(completed).toBe(false)
      release()
      await holder
      expect((await saving).revision).toBe(1)
      expect(store.read().revision).toBe(1)
    } finally {
      release()
      await Promise.allSettled([holder, saving, pendingWrite])
    }
  } finally {
    release?.()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps the committed model view after PostgreSQL rejects a save at COMMIT and accepts a later save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-model-commit-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  try {
    const store = new PostgresSharedModelStore(database, new FileSharedModelProjection(root))
    await store.initialize()
    await database.query(`CREATE TABLE dsh_phalanx.commit_parents(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.commit_children(id integer REFERENCES dsh_phalanx.commit_parents(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_model_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.commit_children VALUES(42); RETURN NEW; END $$;
      CREATE TRIGGER reject_model_commit AFTER UPDATE ON dsh_phalanx.shared_model_settings FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_model_commit();`)
    await expect(store.save({ revision: 1, providers: [], defaultModelId: null })).rejects.toMatchObject({ code: 'query-failed', sqlState: '23503' })
    expect(store.read()).toEqual({ revision: 0, providers: [], defaultModelId: null })
    const reopened = new PostgresSharedModelStore(other, new FileSharedModelProjection(root))
    await reopened.initialize()
    expect(reopened.read()).toEqual({ revision: 0, providers: [], defaultModelId: null })
    await database.query('DROP TRIGGER reject_model_commit ON dsh_phalanx.shared_model_settings')
    await store.save({ revision: 1, providers: [], defaultModelId: null })
    expect(store.read().revision).toBe(1)
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects a provider credential copied to another PostgreSQL row instead of loading a fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-model-aad-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  try {
    const store = new PostgresSharedModelStore(database, new FileSharedModelProjection(root))
    await store.initialize()
    await store.save({
      revision: 1,
      defaultModelId: 'one-chat',
      providers: ['one', 'two'].map(id => ({
        id: 'provider-' + id,
        name: id,
        baseUrl: 'https://models.example.test/anthropic',
        apiFormat: 'anthropic-messages',
        apiKey: 'fictional-provider-' + id,
        enabled: true,
        models: [{ id: id + '-chat', name: 'fixture-chat', enabled: true, input: 'text' }],
      })),
    })
    await database.query(
      "UPDATE dsh_phalanx.shared_model_providers SET api_key=(SELECT api_key FROM dsh_phalanx.shared_model_providers WHERE id='provider-one') WHERE id='provider-two'",
    )
    const reopened = new PostgresSharedModelStore(other, new FileSharedModelProjection(root))
    await expect(reopened.initialize()).rejects.toThrow('Cannot decrypt platform secret at shared_model_providers/provider-two/api_key')
    expect(() => reopened.read()).toThrow('not ready')
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('accepts only one revision when independent PostgreSQL owners save the same previous model revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-model-revision-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  try {
    const first = new PostgresSharedModelStore(database, new FileSharedModelProjection(root)),
      second = new PostgresSharedModelStore(other, new FileSharedModelProjection(root))
    await Promise.all([first.initialize(), second.initialize()])
    const outcomes = await Promise.allSettled([
      first.save({ revision: 1, providers: [], defaultModelId: null }),
      second.save({ revision: 1, providers: [], defaultModelId: null }),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({
      reason: { code: 'model-revision-conflict', params: { expectedRevision: 1, receivedRevision: 0 } },
    })
    const reopened = new PostgresSharedModelStore(other, new FileSharedModelProjection(root))
    await reopened.initialize()
    expect(reopened.read()).toEqual({ revision: 1, providers: [], defaultModelId: null })
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('reports a committed publication failure and recovers the latest PostgreSQL revision before another save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-model-pending-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const state = (revision: number, name: string): SharedModelState => ({
    revision,
    defaultModelId: 'chat',
    providers: [
      {
        id: 'provider',
        name,
        baseUrl: 'https://models.example.test/anthropic',
        apiFormat: 'anthropic-messages',
        apiKey: 'fictional-provider-credential',
        enabled: true,
        models: [{ id: 'chat', name: 'chat', enabled: true, input: 'text' }],
      },
    ],
  })
  const catalogPath = join(root, 'managed-models/catalog.json')
  try {
    const store = new PostgresSharedModelStore(database, new FileSharedModelProjection(root))
    await store.initialize()
    await rm(catalogPath)
    await mkdir(catalogPath)
    await expect(store.save(state(1, 'First'))).rejects.toMatchObject({ code: 'model-projection-pending', params: { revision: 1 } })
    expect(store.read()).toEqual(state(1, 'First'))
    const independent = new PostgresSharedModelStore(other, new FileSharedModelProjection(join(root, 'other')))
    await independent.initialize()
    expect(independent.read()).toEqual(state(1, 'First'))
    await independent.save(state(2, 'Second'))
    await rm(catalogPath, { recursive: true })
    await expect(store.save(state(2, 'First'))).rejects.toMatchObject({ code: 'model-revision-conflict', params: { expectedRevision: 2, receivedRevision: 1 } })
    expect(store.read()).toEqual(state(2, 'Second'))
    expect(await readFile(catalogPath, 'utf8')).toContain('Second / chat')
    expect(await readFile(catalogPath, 'utf8')).not.toContain('First / chat')
    await store.save(state(3, 'Third'))
    expect(await readFile(catalogPath, 'utf8')).toContain('Third / chat')
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('drains accepted model writes before closing and rejects later work without closing the shared database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-model-close-'))
  const database = await openTestDatabase(root)
  let release!: () => void, saving: Promise<void> | undefined, closing: Promise<void> | undefined, holder: Promise<void> | undefined
  try {
    const store = new PostgresSharedModelStore(database, new FileSharedModelProjection(root))
    await store.initialize()
    let entered!: () => void,
      closed = false
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    holder = database.transaction(async sql => {
      await sql.query('SELECT id FROM dsh_phalanx.shared_model_settings WHERE id=1 FOR UPDATE')
      entered()
      await gate
    })
    await began
    saving = store.save({ revision: 1, providers: [], defaultModelId: null })
    await expect
      .poll(async () =>
        Number(
          (
            await database.query<{ waiting: string }>(
              "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
            )
          )[0]!.waiting,
        ),
      )
      .toBeGreaterThan(0)
    closing = store.close().then(() => {
      closed = true
    })
    await expect(store.save({ revision: 2, providers: [], defaultModelId: null })).rejects.toThrow('closed')
    expect(closed).toBe(false)
    release()
    await holder
    await saving
    await closing
    expect(() => store.read()).toThrow('closed')
    await expect(store.initialize()).rejects.toThrow('closed')
    expect(Number((await database.query<{ revision: string }>('SELECT revision FROM dsh_phalanx.shared_model_settings WHERE id=1'))[0]!.revision)).toBe(1)
  } finally {
    release?.()
    await Promise.allSettled([holder, saving, closing])
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
