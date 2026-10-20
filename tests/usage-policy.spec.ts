import { expect, it } from 'vitest'
import { UsagePolicy } from '../src/use-cases/usage-policy.js'
import type { UsageEntry } from '../src/domain/usage-record.js'

it('fixes the starting group, records only usage metadata and finishes each attempt once', () => {
  let now = 1000
  const rows: UsageEntry[] = [], cutoffs: number[] = []
  const policy = new UsagePolicy({ append: row => { rows.push(row) }, prune: cutoff => { cutoffs.push(cutoff) }, retentionDays: () => 180, saveRetention() {}, view: () => { throw Error('unused') } }, { now: () => now }, { get: () => undefined })
  const member = { username: 'member', groupId: 'initial' }
  const capability = { kind: 'plugin-upstream' as const, id: 'fixture-plugin', operation: 'search', privateBody: 'PRIVATE' }
  const attempt = policy.begin(member, capability)
  expect(attempt.allowed).toBe(true)
  member.groupId = 'changed'; capability.operation = 'changed'; now = 1250
  attempt.finish({ outcome: 'succeeded', httpStatus: 200 })
  attempt.finish({ outcome: 'failed', httpStatus: 502 })
  expect(rows).toEqual([{ username: 'member', groupId: 'initial', capability: { kind: 'plugin-upstream', id: 'fixture-plugin', operation: 'search' }, startedAt: 1000, durationMs: 250, outcome: 'succeeded', httpStatus: 200 }])
  expect(cutoffs.at(-1)).toBe(1250 - 180 * 86400000)
})

it('returns a neutral denial and retains it under an injected policy, with deterministic retention cleanup', () => {
  const rows: UsageEntry[] = [], cutoffs: number[] = []
  let now = 0
  const policy = new UsagePolicy({ append: row => { rows.push(row) }, prune: cutoff => { cutoffs.push(cutoff) }, retentionDays: () => 7, saveRetention() {}, view: () => { throw Error('unused') } }, { now: () => now }, { get: () => undefined }, { allow: () => false })
  const attempt = policy.begin({ username: 'admin', groupId: 'admin' }, { kind: 'plugin-upstream', id: 'fixture', operation: 'search' })
  expect(attempt.allowed).toBe(false)
  now = 100; attempt.finish({ outcome: 'denied', reason: 'policy', httpStatus: 403 })
  expect(rows).toMatchObject([{ username: 'admin', groupId: 'admin', outcome: 'denied', reason: 'policy', httpStatus: 403, durationMs: 100 }])
  now = 8 * 86400000; policy.prune()
  expect(cutoffs.at(-1)).toBe(86400000)
})

it('restricts views and retention to current administrators and cleans on settings and background maintenance', () => {
  let now = 0, days = 180, scheduled!: () => void, stopped = false
  const current = { username: 'admin', spaceId: 's', sessionEpoch: 0, groupId: 'admin', admin: true, disabled: false, email: '', createdAt: 0, updatedAt: 0 }
  const actor = { username: 'admin', spaceId: 's', sessionEpoch: 0 }
  let rows: UsageEntry[] = []
  const policy = new UsagePolicy({ append: row => { rows.push(row) }, retentionDays: () => days, saveRetention: value => { days = value }, prune: cutoff => { rows = rows.filter(row => row.startedAt >= cutoff) },
    view: () => ({ items: [], total: rows.length, page: 1, pageCount: 1, summaries: { members: [], groups: [], capabilities: [], days: [] } }) }, { now: () => now }, { get: () => current }, undefined,
    { start: cleanup => { scheduled = cleanup; return () => { stopped = true } } })
  policy.start(); policy.begin({ username: 'admin', groupId: 'admin' }, { kind: 'plugin-upstream', id: 'fixture', operation: 'search' }).finish({ outcome: 'succeeded' })
  expect(policy.settings(actor)).toEqual({ retentionDays: 180 })
  now = 8 * 86400000
  expect(policy.saveRetention(actor, { retentionDays: 7 })).toEqual({ retentionDays: 7 }); expect(policy.view(actor, {}).total).toBe(0)
  for (const input of [{ retentionDays: 0 }, { retentionDays: 3651 }, { retentionDays: '7' }, { retentionDays: 7, extra: true }]) expect(() => policy.saveRetention(actor, input)).toThrow()
  for (const query of [{ from: NaN }, { from: 100, until: 0 }, { page: 0 }]) expect(() => policy.view(actor, query)).toThrow()
  current.admin = false; expect(() => policy.view(actor, {})).toThrow('Administrator access is required')
  expect(() => policy.saveRetention(actor, { retentionDays: 1 })).toThrow('Administrator access is required')
  current.admin = true; current.sessionEpoch = 1; expect(() => policy.settings(actor)).toThrow('Sign in is required')
  current.sessionEpoch = 0; current.disabled = true; expect(() => policy.view(actor, {})).toThrow('Sign in is required')
  current.disabled = false
  policy.begin({ username: 'member', groupId: 'g' }, { kind: 'plugin-upstream', id: 'fixture', operation: 'search' }).finish({ outcome: 'succeeded' })
  now += 8 * 86400000; scheduled(); expect(rows).toEqual([])
  policy.stop(); expect(stopped).toBe(true)
})
