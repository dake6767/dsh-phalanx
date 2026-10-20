import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteUsageRecords } from '../src/adapters/usage-records.js'

it('retains metadata, settings and filtered aggregates across reopening and prunes expired rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-records-')), path = join(root, 'usage-records.db')
  let store = new SqliteUsageRecords(path)
  try {
    expect(store.retentionDays()).toBe(180)
    const entry = { username: 'member', groupId: 'before', capability: { kind: 'plugin-upstream' as const, id: 'plugin', operation: 'search' }, startedAt: Date.UTC(2026, 0, 1), durationMs: 25, outcome: 'succeeded' as const, httpStatus: 200 }
    store.append(entry); store.append({ ...entry, username: 'admin', groupId: 'admin', startedAt: entry.startedAt + 86400000, outcome: 'denied', reason: 'access', httpStatus: 403 })
    store.saveRetention(7); store.close(); store = new SqliteUsageRecords(path)
    expect(store.retentionDays()).toBe(7)
    expect(store.view({}).summaries).toEqual({ members: [{ key: 'admin', count: 1 }, { key: 'member', count: 1 }], groups: [{ key: 'admin', count: 1 }, { key: 'before', count: 1 }], capabilities: [{ key: '["plugin-upstream","plugin","search"]', count: 2, capability: { kind: 'plugin-upstream', id: 'plugin', operation: 'search' } }], days: [{ key: '2026-01-01', count: 1 }, { key: '2026-01-02', count: 1 }] })
    const filtered = store.view({ username: 'member', groupId: 'before', capability: 'plugin', operation: 'search', outcome: 'succeeded', from: entry.startedAt, until: entry.startedAt + 1 })
    expect(filtered).toMatchObject({ total: 1, page: 1, pageCount: 1, items: [{ ...entry, id: 1 }] })
    expect(store.view({ outcome: 'failed' }).total).toBe(0)
    store.prune(entry.startedAt + 1); expect(store.view({}).items).toMatchObject([{ username: 'admin' }])
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

it('refuses a future schema without modifying it', () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-schema-')), path = join(root, 'usage.db')
  try {
    const db = new DatabaseSync(path); db.exec('PRAGMA user_version=99'); db.close()
    expect(() => new SqliteUsageRecords(path)).toThrow('unsupported usage records schema')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('imports legacy MCP tools exactly once, retaining legitimate duplicates and leaving missing fields empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-import-')), path = join(root, 'usage.db'), audit = join(root, 'audit.json')
  const row = { username: 'member', service: 'p-docs', method: 'tools/call', status: 'failed', startedAt: 1000, durationMs: 25, privateOutput: 'PRIVATE_OUTPUT' }
  writeFileSync(audit, JSON.stringify([row, row, { ...row, method: 'initialize' }]))
  let store = new SqliteUsageRecords(path, { mcpAuditPath: audit })
  try {
    expect(store.view({}).total).toBe(2)
    expect(store.view({}).items).toMatchObject([{ username: 'member', groupId: null, capability: { kind: 'mcp', id: 'p-docs', operation: '' }, outcome: 'failed', startedAt: 1000, durationMs: 25 }, { username: 'member' }])
    expect(JSON.stringify(store.view({}))).not.toContain('PRIVATE_')
    store.append({ username: 'new', groupId: 'current', capability: { kind: 'mcp', id: 'p-docs', operation: 'read' }, startedAt: 2000, durationMs: 1, outcome: 'succeeded' })
    store.close(); store = new SqliteUsageRecords(path, { mcpAuditPath: audit })
    expect(store.view({}).total).toBe(3)
    writeFileSync(audit, '{invalid later source')
    store.close(); store = new SqliteUsageRecords(path, { mcpAuditPath: audit })
    expect(store.view({}).total).toBe(3)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

it('rejects a malformed legacy snapshot without partial imports and can retry the repaired source', () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-import-invalid-')), path = join(root, 'usage.db'), audit = join(root, 'audit.json')
  const row = { username: 'member', service: 'p-docs', method: 'tools/call', tool: 'read', status: 'success', startedAt: 1000, durationMs: 5 }
  try {
    writeFileSync(audit, JSON.stringify([row, { ...row, durationMs: 'bad' }]))
    expect(() => new SqliteUsageRecords(path, { mcpAuditPath: audit })).toThrow('Invalid legacy MCP usage records')
    const empty = new SqliteUsageRecords(path); expect(empty.view({}).total).toBe(0); empty.close()
    writeFileSync(audit, JSON.stringify([row]))
    const repaired = new SqliteUsageRecords(path, { mcpAuditPath: audit }); expect(repaired.view({}).total).toBe(1); repaired.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('imports all historical execution rows once, including duplicates and carrier owners, without inventing missing metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'execution-import-')), path = join(root, 'usage.db'), audit = join(root, 'execution.json')
  const legacy = { mcpAuditPath: join(root, 'absent-mcp.json'), executionAuditPath: audit }
  const row = { username: 'member', owner: 'skill:news', command: 'news-cli', startedAt: 1000, durationMs: 5, exitCode: 7, privateOutput: 'PRIVATE_OUTPUT' }
  writeFileSync(audit, JSON.stringify([row, row, { username: 'member', owner: 'mcp:p-docs', command: 'node', startedAt: 2000, durationMs: 10, reason: 'idle-reclaimed' }]))
  let store = new SqliteUsageRecords(path, legacy)
  try {
    expect(store.view({}).items).toMatchObject([
      { username: 'member', groupId: null, capability: { kind: 'execution', id: 'mcp:p-docs', operation: 'node' }, outcome: 'failed', reason: 'idle-reclaimed' },
      { username: 'member', groupId: null, capability: { kind: 'execution', id: 'skill:news', operation: 'news-cli' }, outcome: 'failed', exitCode: 7 },
      { username: 'member', groupId: null, capability: { kind: 'execution', id: 'skill:news', operation: 'news-cli' }, outcome: 'failed', exitCode: 7 },
    ])
    expect(store.view({}).items.every(row => row.capability.firstArgument === undefined)).toBe(true)
    expect(JSON.stringify(store.view({}))).not.toContain('PRIVATE_')
    store.close(); store = new SqliteUsageRecords(path, legacy); expect(store.view({}).total).toBe(3)
    writeFileSync(audit, '{invalid changed source')
    store.close(); store = new SqliteUsageRecords(path, legacy); expect(store.view({}).total).toBe(3)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

it('rejects incomplete execution imports without partial rows, then retries the repaired snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'execution-import-invalid-')), path = join(root, 'usage.db'), audit = join(root, 'execution.json')
  const legacy = { mcpAuditPath: join(root, 'absent-mcp.json'), executionAuditPath: audit }
  const row = { username: 'member', owner: 'skill:news', command: 'news-cli', startedAt: 1000, durationMs: 5, exitCode: 0 }
  try {
    writeFileSync(audit, JSON.stringify([row, { ...row, reason: 'not-a-valid-reason' }]))
    expect(() => new SqliteUsageRecords(path, legacy)).toThrow('Invalid legacy execution usage records')
    const empty = new SqliteUsageRecords(path); expect(empty.view({}).total).toBe(0); empty.saveRetention(7); empty.close()
    writeFileSync(audit, JSON.stringify([row]))
    const repaired = new SqliteUsageRecords(path, legacy)
    expect(repaired.view({}).total).toBe(1); expect(repaired.retentionDays()).toBe(7); repaired.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
