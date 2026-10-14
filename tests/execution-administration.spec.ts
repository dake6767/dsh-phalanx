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

it('prefills contribution declarations without exposing or replacing existing secrets and checks command ownership before adoption', async () => {
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }, rows = new Map<string, ExecutionConfiguration>()
  const service = new ExecutionAdministration({ get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) }, { get: id => ({ id, version: 'version' }), owns: () => true }, { get: owner => rows.get(owner), save: (owner, value) => { rows.set(owner, value) }, list: () => [...rows].map(([owner, configuration]) => ({ owner, configuration })) }, async () => {})
  const declaration = { purpose: 'Search', execution: { commands: [{ command: 'search-cli', blocked: ['login'] }], variables: [{ name: 'SEARCH_KEY', purpose: 'Authenticate', application: 'Provider dashboard' }] } }
  service.checkContribution('search', declaration)
  expect(service.contributionPreview('search', declaration)).toMatchObject({ enabled: false, commands: declaration.execution.commands, variables: [{ name: 'SEARCH_KEY', secret: true, configured: false }] })
  await service.save(actor, 'skill:search', { enabled: true, commands: [{ command: 'old-search', blocked: [] }], variables: [{ name: 'SEARCH_KEY', value: 'previous-platform-secret', secret: true }] })
  const preview = service.contributionPreview('search', declaration)
  expect(JSON.stringify(preview)).not.toContain('previous-platform-secret')
  const row = { name: 'search', hash: 'version', description: 'Search', markdown: '# Search', files: [], id: 'id', revision: 'revision', contributor: actor, declaration, submittedAt: 0, updatedAt: 0, status: 'pending' as const }
  await service.adoptContribution(row)
  expect(rows.get('skill:search')).toMatchObject({ enabled: true, commands: [{ command: 'old-search', blocked: [] }, { command: 'search-cli', blocked: ['login'] }], variables: [{ name: 'SEARCH_KEY', value: 'previous-platform-secret', secret: true }] })
  await expect(service.save(actor, 'skill:other', { enabled: true, commands: [{ command: 'search-cli', blocked: [] }], variables: [] })).rejects.toMatchObject({ code: 'execution-config-invalid' })
  rows.set('skill:another', { enabled: true, commands: [{ command: 'fresh-command', blocked: [] }], variables: [] })
  expect(() => service.checkContribution('new', { purpose: 'New skill', execution: { commands: [{ command: 'fresh-command', blocked: [] }], variables: [] } })).toThrow(expect.objectContaining({ code: 'execution-config-invalid' }))
})

it('replays contribution recovery without overwriting credentials the administrator subsequently changed', async () => {
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }, rows = new Map<string, ExecutionConfiguration>()
  let changed = 0
  const service = new ExecutionAdministration({ get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) }, { get: id => ({ id, version: 'version' }), owns: () => true }, { get: owner => rows.get(owner), save: (owner, value) => { rows.set(owner, value) }, list: () => [...rows].map(([owner, configuration]) => ({ owner, configuration })) }, async () => { if (++changed === 1) throw new Error('projection interrupted') })
  const row = { name: 'search', hash: 'version', description: 'Search', markdown: '# Search', files: [], id: 'id', revision: 'revision', contributor: actor, declaration: { purpose: 'Search' }, submittedAt: 0, updatedAt: 0, status: 'pending' as const }
  const setup = { enabled: true, commands: [{ command: 'search', blocked: [] }], variables: [{ name: 'KEY', value: 'first-platform-secret', secret: true }] }
  await expect(service.adoptContribution(row, setup)).rejects.toThrow('projection interrupted')
  await service.save(actor, 'skill:search', { ...setup, variables: [{ name: 'KEY', value: 'later-platform-secret', secret: true }] })
  await service.adoptContribution(row, setup)
  expect(rows.get('skill:search')!.variables[0]!.value).toBe('later-platform-secret')
  expect((await service.view(actor, 'skill:search')).awaitingPreparation).toBe(true)
  await service.reprepare(actor, 'skill:search')
  expect((await service.view(actor, 'skill:search')).awaitingPreparation).toBe(false)
})

it('retains a concurrently conflicting adoption disabled and requires explicit preparation even if it was initially disabled', async () => {
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }, rows = new Map<string, ExecutionConfiguration>()
  const service = new ExecutionAdministration({ get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) }, { get: id => ({ id, version: 'version' }), owns: () => true }, { get: owner => rows.get(owner), save: (owner, value) => { rows.set(owner, value) }, list: () => [...rows].map(([owner, configuration]) => ({ owner, configuration })) }, async () => {})
  const row = { name: 'guide', hash: 'version', description: 'Guide', markdown: '# Guide', files: [], id: 'id', revision: 'revision', contributor: actor, declaration: { purpose: 'Guide' }, submittedAt: 0, updatedAt: 0, status: 'pending' as const }
  const setup = { enabled: true, commands: [{ command: 'guide', blocked: [] }], variables: [] }
  service.checkAdoption(row, setup)
  await service.save(actor, 'skill:other', setup)
  expect(await service.adoptContribution(row, setup)).toEqual([expect.stringContaining('disabled')])
  expect(await service.view(actor, 'skill:guide')).toMatchObject({ enabled: false, awaitingPreparation: true })
  await service.save(actor, 'skill:other', { ...setup, enabled: false })
  await service.save(actor, 'skill:guide', setup)
  expect((await service.view(actor, 'skill:guide')).awaitingPreparation).toBe(true)
  await service.reprepare(actor, 'skill:guide')
  expect((await service.view(actor, 'skill:guide')).awaitingPreparation).toBe(false)
  await service.adoptContribution(row, setup)
  expect((await service.view(actor, 'skill:guide')).enabled).toBe(true)
})

it('approves only the selected receipt on Prepare and keeps approval private through subsequent saves', async () => {
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }, rows = new Map<string, ExecutionConfiguration>()
  let preparationApproval = 'selected-receipt', restarts = 0
  const service = new ExecutionAdministration({ get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) }, { get: id => ({ id, version: 'same-bytes', preparationApproval }), owns: () => true }, { get: owner => rows.get(owner), save: (owner, value) => { rows.set(owner, value) }, list: () => [...rows].map(([owner, configuration]) => ({ owner, configuration })) }, async () => {}, { view: () => undefined, restart: () => { restarts++ } })
  const input = { enabled: true, commands: [{ command: 'search', blocked: [] }], variables: [] }
  await service.save(actor, 'skill:search', input)
  expect(await service.view(actor, 'skill:search')).toMatchObject({ awaitingPreparation: true })
  const prepared = await service.reprepare(actor, 'skill:search')
  expect(prepared.awaitingPreparation).toBe(false); expect(prepared).not.toHaveProperty('approvedContribution'); expect(restarts).toBe(1)
  expect(rows.get('skill:search')?.approvedContribution).toBe('selected-receipt')
  await service.save(actor, 'skill:search', input)
  expect(rows.get('skill:search')?.approvedContribution).toBe('selected-receipt')
  preparationApproval = 'next-same-bytes-receipt'
  expect((await service.view(actor, 'skill:search')).awaitingPreparation).toBe(true)
  expect(service.contributionPreview('search', { purpose: 'Update' })).not.toHaveProperty('approvedContribution')
})

it('selects ready runtime dependencies while allowing credential changes on an existing migration fallback', async () => {
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
  let config: ExecutionConfiguration = { enabled: true, commands: [{ command: 'news', blocked: [] }], variables: [], runtimeDependencies: ['migration'] }
  const checked: string[][] = []
  const service = new ExecutionAdministration({ get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    { get: id => ({ id, version: 'v1' }), owns: () => true }, { get: () => config, list: () => [{ owner: 'skill:news', configuration: config }], save: (_, value) => { config = value } }, async () => {}, undefined, undefined,
    { ready: names => { checked.push([...names]); if (names.includes('unavailable')) throw new Error('not ready'); return [] } })
  await service.save(actor, 'skill:news', { ...config, variables: [{ name: 'KEY', value: 'new', secret: true }] })
  expect(checked).toEqual([[]])
  await expect(service.save(actor, 'skill:news', { ...config, runtimeDependencies: ['unavailable'] })).rejects.toThrow('not ready')
  await expect(service.save(actor, 'skill:news', { ...config, prepare: 'install-new' })).rejects.toMatchObject({ code: 'execution-config-invalid' })
  expect(config.runtimeDependencies).toEqual(['migration'])
})
