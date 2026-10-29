import { expect, it } from 'vitest'
import { UsagePolicy } from '../src/use-cases/usage-policy.js'
import type { UsageEntry, UsageModelBucket } from '../src/domain/usage-record.js'
it('fixes the starting group, records only usage metadata and finishes each attempt once', async () => {
  let now = 1000
  const rows: UsageEntry[] = [],
    cutoffs: number[] = []
  const policy = new UsagePolicy(
    {
      async appendReported() {
        throw Error('unused')
      },
      async reported() {
        throw Error('unused')
      },
      async appendModel() {
        throw Error('unused')
      },
      async models() {
        throw Error('unused')
      },
      append: async row => {
        rows.push(row)
      },
      prune: async cutoff => {
        cutoffs.push(cutoff)
      },
      retentionDays: async () => 180,
      async saveRetention() {},
      view: async () => {
        throw Error('unused')
      },
    },
    { now: () => now },
    { get: async () => undefined },
  )
  const member = { username: 'member', groupId: 'initial' }
  const capability = { kind: 'plugin-upstream' as const, id: 'fixture-plugin', operation: 'search', privateBody: 'PRIVATE' }
  const attempt = policy.begin(member, capability)
  expect(attempt.allowed).toBe(true)
  member.groupId = 'changed'
  capability.operation = 'changed'
  now = 1250
  await attempt.finish({ outcome: 'succeeded', httpStatus: 200 })
  await attempt.finish({ outcome: 'failed', httpStatus: 502 })
  expect(rows).toEqual([
    {
      username: 'member',
      groupId: 'initial',
      capability: { kind: 'plugin-upstream', id: 'fixture-plugin', operation: 'search' },
      startedAt: 1000,
      durationMs: 250,
      outcome: 'succeeded',
      httpStatus: 200,
    },
  ])
  expect(cutoffs.at(-1)).toBe(1250 - 180 * 86400000)
})
it('returns a neutral denial and retains it under an injected policy, with deterministic retention cleanup', async () => {
  const rows: UsageEntry[] = [],
    cutoffs: number[] = []
  let now = 0
  const policy = new UsagePolicy(
    {
      async appendReported() {
        throw Error('unused')
      },
      async reported() {
        throw Error('unused')
      },
      async appendModel() {
        throw Error('unused')
      },
      async models() {
        throw Error('unused')
      },
      append: async row => {
        rows.push(row)
      },
      prune: async cutoff => {
        cutoffs.push(cutoff)
      },
      retentionDays: async () => 7,
      async saveRetention() {},
      view: async () => {
        throw Error('unused')
      },
    },
    { now: () => now },
    { get: async () => undefined },
    { allow: () => false },
  )
  const attempt = policy.begin({ username: 'admin', groupId: 'admin' }, { kind: 'plugin-upstream', id: 'fixture', operation: 'search' })
  expect(attempt.allowed).toBe(false)
  now = 100
  await attempt.finish({ outcome: 'denied', reason: 'policy', httpStatus: 403 })
  expect(rows).toMatchObject([{ username: 'admin', groupId: 'admin', outcome: 'denied', reason: 'policy', httpStatus: 403, durationMs: 100 }])
  now = 8 * 86400000
  await policy.prune()
  expect(cutoffs.at(-1)).toBe(86400000)
})
it('restricts views and retention to current administrators and cleans on settings and background maintenance', async () => {
  let now = 0,
    days = 180,
    scheduled!: () => void,
    stopped = false
  const current = { username: 'admin', spaceId: 's', sessionEpoch: 0, groupId: 'admin', admin: true, disabled: false, email: '', createdAt: 0, updatedAt: 0 }
  const actor = { username: 'admin', spaceId: 's', sessionEpoch: 0 }
  let rows: UsageEntry[] = []
  const policy = new UsagePolicy(
    {
      async appendReported() {
        throw Error('unused')
      },
      async reported() {
        throw Error('unused')
      },
      async appendModel() {
        throw Error('unused')
      },
      async models() {
        throw Error('unused')
      },
      append: async row => {
        rows.push(row)
      },
      retentionDays: async () => days,
      saveRetention: async value => {
        days = value
      },
      prune: async cutoff => {
        rows = rows.filter(row => row.startedAt >= cutoff)
      },
      view: async () => ({ items: [], total: rows.length, page: 1, pageCount: 1, summaries: { members: [], groups: [], capabilities: [], days: [] } }),
    },
    { now: () => now },
    { get: async () => current },
    undefined,
    {
      start: cleanup => {
        scheduled = cleanup
        return () => {
          stopped = true
        }
      },
    },
  )
  await policy.start()
  await policy.begin({ username: 'admin', groupId: 'admin' }, { kind: 'plugin-upstream', id: 'fixture', operation: 'search' }).finish({ outcome: 'succeeded' })
  expect(await policy.settings(actor)).toEqual({ retentionDays: 180 })
  now = 8 * 86400000
  expect(await policy.saveRetention(actor, { retentionDays: 7 })).toEqual({ retentionDays: 7 })
  expect((await policy.view(actor, {})).total).toBe(0)
  for (const input of [{ retentionDays: 0 }, { retentionDays: 3651 }, { retentionDays: '7' }, { retentionDays: 7, extra: true }])
    await expect(async () => await policy.saveRetention(actor, input)).rejects.toThrow()
  for (const query of [{ from: NaN }, { from: 100, until: 0 }, { page: 0 }]) await expect(async () => await policy.view(actor, query)).rejects.toThrow()
  current.admin = false
  await expect(async () => await policy.view(actor, {})).rejects.toThrow('Administrator access is required')
  await expect(async () => await policy.saveRetention(actor, { retentionDays: 1 })).rejects.toThrow('Administrator access is required')
  current.admin = true
  current.sessionEpoch = 1
  await expect(async () => await policy.settings(actor)).rejects.toThrow('Sign in is required')
  current.sessionEpoch = 0
  current.disabled = true
  await expect(async () => await policy.view(actor, {})).rejects.toThrow('Sign in is required')
  current.disabled = false
  await policy.begin({ username: 'member', groupId: 'g' }, { kind: 'plugin-upstream', id: 'fixture', operation: 'search' }).finish({ outcome: 'succeeded' })
  now += 8 * 86400000
  scheduled()
  await policy.stop()
  expect(rows).toEqual([])
  expect(stopped).toBe(true)
})
it('fixes model hour and group at start, retains partial usage and distinguishes denied requests', async () => {
  let now = 3599999
  const buckets: UsageModelBucket[] = [],
    tools: UsageEntry[] = []
  const records = {
    async appendReported() {
      throw Error('unused')
    },
    async reported() {
      throw Error('unused')
    },
    appendModel: async (bucket: UsageModelBucket) => {
      buckets.push(bucket)
    },
    async models() {
      throw Error('unused')
    },
    append: async (row: UsageEntry) => {
      tools.push(row)
    },
    async prune() {},
    retentionDays: async () => 180,
    async saveRetention() {},
    async view() {
      throw Error('unused')
    },
  }
  const policy = new UsagePolicy(records, { now: () => now }, { get: async () => undefined })
  const member = { username: 'member', groupId: 'before' }
  const attempt = policy.begin(member, { kind: 'model', id: 'model', operation: 'messages' })
  member.groupId = 'after'
  now = 3600001
  await attempt.finish({ outcome: 'failed', tokens: { input: 10, output: null, cacheRead: 2, cacheWrite: 3 }, usageUnknown: true })
  await attempt.finish({ outcome: 'succeeded' })
  const denied = new UsagePolicy(records, { now: () => now }, { get: async () => undefined }, { allow: () => false })
  await denied.begin(member, { kind: 'model', id: 'model', operation: 'messages' }).finish({ outcome: 'denied' })
  expect(buckets).toEqual([
    {
      username: 'member',
      groupId: 'before',
      modelId: 'model',
      hour: 0,
      requests: 1,
      unknownRequests: 1,
      deniedRequests: 0,
      tokens: { input: 10, output: null, cacheRead: 2, cacheWrite: 3 },
    },
    {
      username: 'member',
      groupId: 'after',
      modelId: 'model',
      hour: 3600000,
      requests: 1,
      unknownRequests: 0,
      deniedRequests: 1,
      tokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
    },
  ])
  expect(tools).toEqual([])
})
it('accepts only currently held skill reports with server day and group, bounded batches and member rate limits', async () => {
  let now = 86400001,
    allowed = ['managed', 'selected', 'expert'],
    days = 180
  const current = {
    username: 'member',
    spaceId: 'space',
    sessionEpoch: 0,
    groupId: 'current',
    admin: false,
    disabled: false,
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }
  const saved: unknown[] = [],
    cutoffs: number[] = []
  const records = {
    async appendModel() {
      throw Error('unused')
    },
    async models() {
      throw Error('unused')
    },
    async append() {
      throw Error('unused')
    },
    async view() {
      throw Error('unused')
    },
    appendReported: async (rows: readonly unknown[]) => {
      saved.push(...rows)
    },
    async reported() {
      throw Error('unused')
    },
    prune: async (cutoff: number) => {
      cutoffs.push(cutoff)
    },
    retentionDays: async () => days,
    saveRetention: async (value: number) => {
      days = value
    },
  }
  const policy = new UsagePolicy(
    records,
    { now: () => now },
    { get: async () => current },
    {
      allow() {
        throw Error('Reports must not request admission')
      },
    },
    undefined,
    { accessible: async () => allowed.map(name => ({ name })) },
  )
  const identity = { username: 'member', groupId: 'untrusted' }
  await policy.receive(identity, {
    username: 'other',
    day: 0,
    items: [
      { name: 'managed', count: 2 },
      { name: 'managed', count: 3 },
      { name: 'selected', count: 1 },
      { name: 'expert', count: 1 },
      { name: 'not-held', count: 100 },
    ],
  })
  expect(saved).toEqual([
    { username: 'member', groupId: 'current', day: 86400000, skill: 'managed', count: 5 },
    { username: 'member', groupId: 'current', day: 86400000, skill: 'selected', count: 1 },
    { username: 'member', groupId: 'current', day: 86400000, skill: 'expert', count: 1 },
  ])
  allowed = []
  await policy.receive(identity, { items: [{ name: 'managed', count: 1 }] })
  expect(saved).toHaveLength(3)
  for (const input of [
    { items: [{ name: 'managed', count: -1 }] },
    { items: [{ name: 'managed', count: Number.MAX_SAFE_INTEGER }] },
    { items: Array.from({ length: 101 }, () => ({ name: 'managed', count: 1 })) },
  ])
    await expect(async () => await policy.receive(identity, input)).rejects.toThrow()
  for (let i = 0; i < 5; i++) await policy.receive(identity, { items: [] })
  await expect(async () => await policy.receive(identity, { items: [] })).rejects.toThrow('Too many skill reports')
  now += 60000
  allowed = ['managed']
  current.groupId = 'later'
  await policy.receive(identity, { items: [{ name: 'managed', count: 1 }] })
  expect(saved.at(-1)).toEqual({ username: 'member', groupId: 'later', day: 86400000, skill: 'managed', count: 1 })
  current.disabled = true
  await expect(async () => await policy.receive(identity, { items: [] })).rejects.toThrow('Sign in is required')
  current.disabled = false
  now += 2 * 86400000
  current.admin = true
  await policy.saveRetention({ username: 'member', spaceId: 'space', sessionEpoch: 0 }, { retentionDays: 1 })
  expect(cutoffs.at(-1)).toBe(now - 86400000)
})
it('drains admitted attempts and their pending writes before shutdown, and shares duplicate finishes', async () => {
  let release!: () => void, writing!: () => void
  const entered = new Promise<void>(resolve => {
    writing = resolve
  })
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  const policy = new UsagePolicy(
    {
      append: async () => {
        writing()
        return pending
      },
      async prune() {},
      retentionDays: async () => 180,
      async saveRetention() {},
      async appendModel() {
        throw Error('unused')
      },
      async models() {
        throw Error('unused')
      },
      async appendReported() {
        throw Error('unused')
      },
      async reported() {
        throw Error('unused')
      },
      async view() {
        throw Error('unused')
      },
    },
    { now: () => 1000 },
    { get: async () => undefined },
  )
  const attempt = policy.begin({ username: 'member', groupId: 'before' }, { kind: 'mcp', id: 'docs', operation: 'read' })
  let stopped = false
  const stopping = Promise.resolve(policy.stop()).then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  const finished = attempt.finish({ outcome: 'succeeded' })
  expect(attempt.finish({ outcome: 'failed' })).toBe(finished)
  await entered
  expect(stopped).toBe(false)
  release()
  await finished
  await stopping
  expect(stopped).toBe(true)
})
