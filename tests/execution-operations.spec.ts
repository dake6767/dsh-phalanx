import { UsagePolicy } from '../src/use-cases/usage-policy.js'
import type { UsageEntry } from '../src/domain/usage-record.js'
import { expect, it } from 'vitest'
import { ExecutionOperations } from '../src/use-cases/execution-operations.js'
import { ExecutionControl } from '../src/use-cases/execution-control.js'
import { PlatformExecution } from '../src/use-cases/platform-execution.js'
import { DEFAULT_EXECUTION_LIMITS } from '../src/domain/execution-control.js'

it('runs trials as the current administrator in their own space and preserves blocked-call output', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let account = { ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  let limits = DEFAULT_EXECUTION_LIMITS, prepared = '', executed = false
  const records: UsageEntry[] = []
  const usage = new UsagePolicy({ appendReported() { throw Error('unused') }, reported() { throw Error('unused') }, appendModel() { throw Error('unused') }, models() { throw Error('unused') }, append: row => { records.push(row) }, prune() {}, retentionDays: () => 180, saveRetention() {}, view: () => { throw Error('unused') } }, { now: () => 1000 }, { get: () => account })
  const control = new ExecutionControl({ get: () => limits, save: value => { limits = value } }, { start: () => ({ signal: new AbortController().signal, dispose() {} }) })
  const execution = new PlatformExecution({ get: id => ({ id, version: 'v1' }), owns: username => username === 'admin' }, { get: () => ({ enabled: true, commands: [{ command: 'news-cli', blocked: ['apikey-get'] }], variables: [] }) },
    { run: async request => { executed = true; expect(request.username).toBe('admin'); expect(request.cwd).toBe('/own/admin/workspace'); expect(request.argv).toEqual(['two words']); return 7 } }, undefined, undefined, control, usage)
  const operations = new ExecutionOperations({ get: () => account }, control, execution, { assertAvailable() {}, prepare: async username => { prepared = username; account = { ...account, groupId: 'changed' }; return { home: '/own/admin/home', workspace: '/own/admin/workspace', spaceId: 'admin-space' } } }, false, () => false)
  expect(operations.settings(actor)).toEqual({ limits: DEFAULT_EXECUTION_LIMITS, isolated: false })
  expect(operations.save(actor, { ...limits, timeoutSeconds: 3 }).limits.timeoutSeconds).toBe(3)
  expect(() => operations.save(actor, { ...limits, timeoutSeconds: 0 })).toThrow()
  expect(await operations.trial(actor, 'skill:news', 'news-cli apikey-get "private-argument"', new AbortController().signal)).toMatchObject({ stdout: 'API Key: Credentials are configured by the platform / 凭据由平台配置。\n', stderr: '', exitCode: 0 })
  expect(prepared).toBe('admin'); expect(executed).toBe(false)
  expect(records).toMatchObject([{ username: 'admin', groupId: 'admin', capability: { kind: 'execution', id: 'skill:news', operation: 'news-cli', firstArgument: 'apikey-get' }, outcome: 'denied', reason: 'blocked', exitCode: 0 }])
  expect(JSON.stringify(records)).not.toContain('private-argument')
  expect(await operations.trial(actor, 'skill:news', 'news-cli "two words"', new AbortController().signal)).toMatchObject({ exitCode: 7 })
  expect(executed).toBe(true)
  account = { ...account, admin: false }
  await expect(operations.trial(actor, 'skill:news', 'news-cli', new AbortController().signal)).rejects.toMatchObject({ code: 'admin-required' })
})
