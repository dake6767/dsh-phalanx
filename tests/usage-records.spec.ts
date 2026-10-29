import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openUsageRecords as openUsage } from './support/usage-store.js'

it('retains metadata, settings and filtered aggregates across reopening and prunes expired rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-records-')),
    path = join(root, 'usage-records.db')
  let store = await openUsage(path)
  try {
    expect(await store.retentionDays()).toBe(180)
    const entry = {
      username: 'member',
      groupId: 'before',
      capability: { kind: 'plugin-upstream' as const, id: 'plugin', operation: 'search' },
      startedAt: Date.UTC(2026, 0, 1),
      durationMs: 25,
      outcome: 'succeeded' as const,
      httpStatus: 200,
    }
    await store.append(entry)
    await store.append({
      ...entry,
      username: 'admin',
      groupId: 'admin',
      startedAt: entry.startedAt + 86400000,
      outcome: 'denied',
      reason: 'access',
      httpStatus: 403,
    })
    await store.saveRetention(7)
    await store.close()
    store = await openUsage(path)
    expect(await store.retentionDays()).toBe(7)
    expect((await store.view({})).summaries).toEqual({
      members: [
        { key: 'admin', count: 1 },
        { key: 'member', count: 1 },
      ],
      groups: [
        { key: 'admin', count: 1 },
        { key: 'before', count: 1 },
      ],
      capabilities: [{ key: '["plugin-upstream","plugin","search"]', count: 2, capability: { kind: 'plugin-upstream', id: 'plugin', operation: 'search' } }],
      days: [
        { key: '2026-01-01', count: 1 },
        { key: '2026-01-02', count: 1 },
      ],
    })
    const filtered = await store.view({
      username: 'member',
      groupId: 'before',
      capability: 'plugin',
      operation: 'search',
      outcome: 'succeeded',
      from: entry.startedAt,
      until: entry.startedAt + 1,
    })
    expect(filtered).toMatchObject({ total: 1, page: 1, pageCount: 1, items: [{ ...entry, id: 1 }] })
    expect((await store.view({ outcome: 'failed' })).total).toBe(0)
    await store.prune(entry.startedAt + 1)
    expect((await store.view({})).items).toMatchObject([{ username: 'admin' }])
  } finally {
    await store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
it('persists hourly model totals, retains unknown fields and starting groups, and expires only whole old buckets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-hours-')),
    path = join(root, 'usage.db')
  let store = await openUsage(path)
  const row = {
    username: 'member',
    groupId: 'before',
    modelId: 'model',
    hour: 0,
    requests: 1,
    unknownRequests: 0,
    deniedRequests: 0,
    tokens: { input: 10, output: 12, cacheRead: 2, cacheWrite: 3 },
  }
  try {
    await store.appendModel(row)
    await store.appendModel({ ...row, unknownRequests: 1, tokens: { input: null, output: 5, cacheRead: null, cacheWrite: 0 } })
    await store.appendModel({ ...row, groupId: 'after', unknownRequests: 1, tokens: { input: 4, output: null, cacheRead: 0, cacheWrite: 0 } })
    await store.appendModel({ ...row, hour: 3600000, groupId: 'after', tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } })
    await store.saveRetention(7)
    await store.close()
    store = await openUsage(path)
    expect(await store.retentionDays()).toBe(7)
    expect((await store.models({ from: 0, until: 3600000 })).items).toEqual([
      {
        username: 'member',
        modelId: 'model',
        requests: 3,
        unknownRequests: 2,
        deniedRequests: 0,
        tokens: { input: 14, output: 17, cacheRead: 2, cacheWrite: 3 },
      },
    ])
    expect((await store.models({ groupId: 'before' })).items[0]).toMatchObject({ requests: 2, tokens: { input: 10, output: 17, cacheRead: 2, cacheWrite: 3 } })
    expect((await store.models({ from: 3600000, until: 7200000 })).items[0]).toMatchObject({
      requests: 1,
      tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    })
    const unknown = {
      ...row,
      modelId: 'unknown-model',
      hour: 3600000,
      unknownRequests: 1,
      tokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
    }
    await store.appendModel(unknown)
    await store.appendModel(unknown)
    expect((await store.models({ modelId: 'unknown-model' })).items[0]).toMatchObject({
      requests: 2,
      unknownRequests: 2,
      tokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
    })
    await store.prune(3599999)
    expect((await store.models({ modelId: 'model' })).items[0]?.requests).toBe(4)
    await store.prune(3600000)
    expect((await store.models({ modelId: 'model' })).items[0]?.requests).toBe(1)
  } finally {
    await store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
it('keeps self-reported skill day counts separate across restarts, group changes and retention', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reported-days-')),
    path = join(root, 'usage.db')
  let store = await openUsage(path)
  const row = { username: 'member', groupId: 'before', day: 0, skill: 'managed', count: 2 }
  try {
    await store.appendReported([row, { ...row, count: 3 }, { ...row, groupId: 'after', count: 1 }, { ...row, day: 86400000, skill: 'expert', count: 4 }])
    await store.close()
    store = await openUsage(path)
    expect((await store.reported({ from: 0, until: 86400000 })).items).toEqual([{ username: 'member', day: 0, skill: 'managed', count: 6 }])
    expect((await store.reported({ groupId: 'before', skill: 'managed' })).items[0]?.count).toBe(5)
    expect((await store.reported({ username: 'other' })).items).toEqual([])
    expect((await store.reported({})).summaries.days).toEqual([
      { key: '1970-01-01', count: 6 },
      { key: '1970-01-02', count: 4 },
    ])
    expect((await store.view({})).total).toBe(0)
    expect((await store.models({})).items).toEqual([])
    await store.prune(86399999)
    expect((await store.reported({})).items).toHaveLength(2)
    await store.prune(86400000)
    expect((await store.reported({})).items).toEqual([{ username: 'member', day: 86400000, skill: 'expert', count: 4 }])
  } finally {
    await store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('rolls back a reported batch when its cumulative count would exceed the safe integer limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-report-overflow-')),
    store = await openUsage(join(root, 'usage'))
  const row = { username: 'member', groupId: 'g', skill: 'managed', day: 0, count: Number.MAX_SAFE_INTEGER }
  try {
    await store.appendReported([row])
    await expect(
      store.appendReported([
        { ...row, skill: 'other', count: 1 },
        { ...row, count: 1 },
      ]),
    ).rejects.toThrow('Skill report count limit reached')
    expect((await store.reported({})).items).toEqual([{ username: 'member', skill: 'managed', day: 0, count: Number.MAX_SAFE_INTEGER }])
  } finally {
    await store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
