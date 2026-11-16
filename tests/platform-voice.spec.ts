import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PostgresPlatformVoice } from '../src/adapters/postgres-platform-voice.js'
import { PlatformVoicePreparationError } from '../src/domain/platform-voice.js'
import type { PlatformVoicePrecision } from '../src/domain/admin-contract.js'
import type { PreparedVoice } from '../src/ports/platform-voice.js'
import { PlatformVoice } from '../src/use-cases/platform-voice.js'
import { openTestDatabase } from './support/community-application.js'

it('keeps the prepared model during a switch and fences late completions after a newer administrator change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-voice-settings-'))
  const database = await openTestDatabase(root)
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const prepared = new Map<PlatformVoicePrecision, PreparedVoice>()
  const pending = new Map<PlatformVoicePrecision, { resolve: () => void; reject: (reason: unknown) => void }>()
  const store = new PostgresPlatformVoice(database)
  const settle = store.settle.bind(store)
  const settleAttempt = vi.spyOn(store, 'settle').mockRejectedValueOnce(new Error('fixture: temporary database failure')).mockImplementation(settle)
  const voice = new PlatformVoice(
    { get: async () => ({ ...actor, disabled: false, admin: true, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }) },
    store,
    {
      bytes: () => 10,
      available: async precision => prepared.get(precision),
      prepare: async (precision, progress, signal) => {
        if (prepared.has(precision)) return prepared.get(precision)!
        await new Promise<void>((resolve, reject) => {
          pending.set(precision, { resolve, reject })
          progress(5)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        const result = { precision, modelDirectory: '/fixtures/' + precision, vadModelPath: '/fixtures/vad' }
        prepared.set(precision, result)
        return result
      },
    },
  )
  const save = async (enabled: boolean, precision: PlatformVoicePrecision) =>
    voice.save(actor, { revision: (await voice.view(actor)).revision, enabled, precision })
  const wait = async (precision: PlatformVoicePrecision) => expect.poll(() => pending.has(precision)).toBe(true)
  try {
    expect(await voice.view(actor)).toMatchObject({ enabled: false, status: 'off', precision: 'int8' })
    await expect(voice.view({ ...actor, sessionEpoch: 1 })).rejects.toMatchObject({ code: 'sign-in-required' })
    await expect(voice.save(actor, { enabled: true, precision: 'int4', revision: 0 })).rejects.toMatchObject({ code: 'platform-voice-settings-invalid' })
    await save(true, 'int8')
    await wait('int8')
    expect(await voice.view(actor)).toMatchObject({ status: 'preparing', progress: { received: 5, total: 10 } })
    expect(await voice.prepared()).toBeUndefined()
    pending.get('int8')!.resolve()
    await expect.poll(async () => (await voice.view(actor)).status, { timeout: 6_000 }).toBe('ready')
    expect((await voice.prepared())?.precision).toBe('int8')
    expect(settleAttempt).toHaveBeenCalledTimes(2)
    await save(true, 'fp32')
    await wait('fp32')
    expect((await voice.prepared())?.precision).toBe('int8')
    pending.get('fp32')!.reject(new PlatformVoicePreparationError('integrity'))
    await expect.poll(async () => (await voice.view(actor)).failure).toBe('integrity')
    expect((await voice.prepared())?.precision).toBe('int8')
    const first = pending.get('fp32')
    await save(true, 'fp32')
    await expect.poll(() => pending.get('fp32') !== first).toBe(true)
    await save(false, 'fp32')
    pending.get('fp32')!.resolve()
    expect(await voice.prepared()).toBeUndefined()
    expect(await voice.view(actor)).toMatchObject({ status: 'off' })
    await save(true, 'int8')
    await expect.poll(async () => (await voice.view(actor)).status).toBe('ready')
    expect((await voice.prepared())?.precision).toBe('int8')
  } finally {
    await voice.stop()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
