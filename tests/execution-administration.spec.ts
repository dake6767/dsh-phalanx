import { expect, it } from 'vitest'
import { ExecutionAdministration } from '../src/use-cases/execution-administration.js'
import type { ExecutionConfiguration } from '../src/domain/platform-execution.js'

it('keeps secret variables write-only through save, retain and change, and requires a current administrator', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let account = { ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  const rows = new Map<string, ExecutionConfiguration>()
  const service = new ExecutionAdministration({ get: () => account }, { get: id => ({ id, version: 'v1' }), owns: () => true }, {
    get: owner => rows.get(owner), save: (owner, value) => { rows.set(owner, value) }, list: () => [...rows].map(([owner, configuration]) => ({ owner, configuration })),
  }, async () => {})
  expect(await service.view(actor, 'skill:news')).toEqual({ enabled: false, commands: [], variables: [] })
  const base = { enabled: true, commands: [{ command: 'news-cli', blocked: [] }], variables: [{ name: 'KEY', value: 'secret-value', secret: true }, { name: 'REGION', value: 'region-one', secret: false }] }
  const saved = await service.save(actor, 'skill:news', base)
  expect(JSON.stringify(saved)).not.toContain('secret-value')
  expect(saved.variables).toEqual([{ name: 'KEY', secret: true, configured: true }, { name: 'REGION', value: 'region-one', secret: false, configured: true }])
  await service.save(actor, 'skill:news', { ...saved, enabled: false })
  expect(rows.get('skill:news')!.variables[0]!.value).toBe('secret-value')
  await expect(service.save(actor, 'skill:news', { ...saved, variables: [{ name: 'KEY', secret: false }] })).rejects.toMatchObject({ code: 'execution-config-invalid' })
  await service.save(actor, 'skill:news', { ...saved, variables: [{ name: 'KEY', secret: true, value: 'replacement' }] })
  expect(rows.get('skill:news')!.variables[0]!.value).toBe('replacement')
  await expect(service.save(actor, 'skill:other', base)).rejects.toMatchObject({ code: 'execution-config-invalid' })
  account = { ...account, admin: false }
  await expect(service.view(actor, 'skill:news')).rejects.toThrow(expect.objectContaining({ code: 'admin-required' }))
  account = { ...account, admin: true, sessionEpoch: 1 }
  await expect(service.save(actor, 'skill:news', base)).rejects.toMatchObject({ code: 'sign-in-required' })
})
