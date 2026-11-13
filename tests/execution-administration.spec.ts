import { installServiceDefinition } from '../src/domain/installed-services.js'
import { expect, it } from 'vitest'
import { ExecutionAdministration } from '../src/use-cases/execution-administration.js'
import type { ExecutionConfiguration } from '../src/domain/platform-execution.js'

it('keeps secret variables write-only through save, retain and change, and requires a current administrator', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let account = { ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  const rows = new Map<string, ExecutionConfiguration>()
  const service = new ExecutionAdministration(
    { get: async () => account },
    { get: id => ({ id, version: 'v1' }), owns: async () => true },
    {
      get: async owner => rows.get(owner),
      save: async (owner, value) => {
        rows.set(owner, value)
      },
      list: async () => [...rows].map(([owner, configuration]) => ({ owner, configuration })),
      remove: async owner => {
        rows.delete(owner)
      },
    },
    async () => {},
  )
  expect(await service.view(actor, 'skill:news')).toEqual({ enabled: false, commands: [], variables: [] })
  const base = {
    enabled: true,
    commands: [{ command: 'news-cli', blocked: [] }],
    variables: [
      { name: 'KEY', value: 'secret-value', secret: true },
      { name: 'REGION', value: 'region-one', secret: false },
    ],
  }
  const saved = await service.save(actor, 'skill:news', base)
  expect(JSON.stringify(saved)).not.toContain('secret-value')
  expect(saved.variables).toEqual([
    { name: 'KEY', secret: true, configured: true, last4: 'alue' },
    { name: 'REGION', value: 'region-one', secret: false, configured: true },
  ])
  await service.save(actor, 'skill:news', { ...saved, enabled: false })
  expect(rows.get('skill:news')!.variables[0]!.value).toBe('secret-value')
  await expect(service.save(actor, 'skill:news', { ...saved, variables: [{ name: 'KEY', secret: false }] })).rejects.toMatchObject({
    code: 'execution-config-invalid',
  })
  await service.save(actor, 'skill:news', { ...saved, variables: [{ name: 'KEY', secret: true, value: 'replacement' }] })
  expect(rows.get('skill:news')!.variables[0]!.value).toBe('replacement')
  await service.save(actor, 'skill:news', { ...saved, variables: [{ name: 'KEY', secret: true, value: '' }] })
  expect(rows.get('skill:news')!.variables[0]!.value).toBe('replacement')
  expect((await service.contributionPreview('news', { purpose: 'Update' })).variables[0]).toMatchObject({ configured: true, last4: 'ment' })
  await expect(service.save(actor, 'skill:news', { ...saved, variables: [{ name: 'KEY', secret: false, value: '' }] })).rejects.toMatchObject({
    code: 'execution-config-invalid',
  })
  await expect(service.save(actor, 'skill:other', base)).rejects.toMatchObject({ code: 'execution-config-invalid' })
  account = { ...account, admin: false }
  await expect(service.view(actor, 'skill:news')).rejects.toThrow(expect.objectContaining({ code: 'admin-required' }))
  account = { ...account, admin: true, sessionEpoch: 1 }
  await expect(service.save(actor, 'skill:news', base)).rejects.toMatchObject({ code: 'sign-in-required' })
})

it('prefills contribution declarations without exposing or replacing existing secrets and checks command ownership before adoption', async () => {
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 },
    rows = new Map<string, ExecutionConfiguration>()
  const service = new ExecutionAdministration(
    { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    { get: id => ({ id, version: 'version' }), owns: async () => true },
    {
      get: async owner => rows.get(owner),
      save: async (owner, value) => {
        rows.set(owner, value)
      },
      list: async () => [...rows].map(([owner, configuration]) => ({ owner, configuration })),
      remove: async owner => {
        rows.delete(owner)
      },
    },
    async () => {},
  )
  const declaration = {
    purpose: 'Search',
    execution: {
      commands: [{ command: 'search-cli', blocked: ['login'] }],
      variables: [{ name: 'SEARCH_KEY', purpose: 'Authenticate', application: 'Provider dashboard' }],
    },
  }
  await service.checkContribution('search', declaration)
  expect(await service.contributionPreview('search', declaration)).toMatchObject({
    enabled: false,
    commands: declaration.execution.commands,
    variables: [{ name: 'SEARCH_KEY', secret: true, configured: false }],
  })
  await service.save(actor, 'skill:search', {
    enabled: true,
    commands: [{ command: 'old-search', blocked: [] }],
    variables: [{ name: 'SEARCH_KEY', value: 'previous-platform-secret', secret: true }],
  })
  const preview = await service.contributionPreview('search', declaration)
  expect(JSON.stringify(preview)).not.toContain('previous-platform-secret')
  const row = {
    name: 'search',
    hash: 'version',
    description: 'Search',
    markdown: '# Search',
    files: [],
    id: 'id',
    revision: 'revision',
    contributor: actor,
    declaration,
    submittedAt: 0,
    updatedAt: 0,
    status: 'pending' as const,
  }
  await service.adoptContribution(row)
  expect(rows.get('skill:search')).toMatchObject({
    enabled: true,
    commands: [
      { command: 'old-search', blocked: [] },
      { command: 'search-cli', blocked: ['login'] },
    ],
    variables: [{ name: 'SEARCH_KEY', value: 'previous-platform-secret', secret: true }],
  })
  await expect(service.save(actor, 'skill:other', { enabled: true, commands: [{ command: 'search-cli', blocked: [] }], variables: [] })).rejects.toMatchObject({
    code: 'execution-config-invalid',
  })
  rows.set('skill:another', { enabled: true, commands: [{ command: 'fresh-command', blocked: [] }], variables: [] })
  await expect(
    service.checkContribution('new', { purpose: 'New skill', execution: { commands: [{ command: 'fresh-command', blocked: [] }], variables: [] } }),
  ).rejects.toMatchObject({ code: 'execution-config-invalid' })
})

it('replays contribution recovery without overwriting credentials the administrator subsequently changed', async () => {
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 },
    rows = new Map<string, ExecutionConfiguration>()
  let changed = 0
  const service = new ExecutionAdministration(
    { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    { get: id => ({ id, version: 'version' }), owns: async () => true },
    {
      get: async owner => rows.get(owner),
      save: async (owner, value) => {
        rows.set(owner, value)
      },
      list: async () => [...rows].map(([owner, configuration]) => ({ owner, configuration })),
      remove: async owner => {
        rows.delete(owner)
      },
    },
    async () => {
      if (++changed === 1) throw new Error('projection interrupted')
    },
  )
  const row = {
    name: 'search',
    hash: 'version',
    description: 'Search',
    markdown: '# Search',
    files: [],
    id: 'id',
    revision: 'revision',
    contributor: actor,
    declaration: { purpose: 'Search' },
    submittedAt: 0,
    updatedAt: 0,
    status: 'pending' as const,
  }
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
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 },
    rows = new Map<string, ExecutionConfiguration>()
  const service = new ExecutionAdministration(
    { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    { get: id => ({ id, version: 'version' }), owns: async () => true },
    {
      get: async owner => rows.get(owner),
      save: async (owner, value) => {
        rows.set(owner, value)
      },
      list: async () => [...rows].map(([owner, configuration]) => ({ owner, configuration })),
      remove: async owner => {
        rows.delete(owner)
      },
    },
    async () => {},
  )
  const row = {
    name: 'guide',
    hash: 'version',
    description: 'Guide',
    markdown: '# Guide',
    files: [],
    id: 'id',
    revision: 'revision',
    contributor: actor,
    declaration: { purpose: 'Guide' },
    submittedAt: 0,
    updatedAt: 0,
    status: 'pending' as const,
  }
  const setup = { enabled: true, commands: [{ command: 'guide', blocked: [] }], variables: [] }
  await service.checkAdoption(row, setup)
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
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 },
    rows = new Map<string, ExecutionConfiguration>()
  let preparationApproval = 'selected-receipt',
    restarts = 0
  const service = new ExecutionAdministration(
    { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    { get: id => ({ id, version: 'same-bytes', preparationApproval }), owns: async () => true },
    {
      get: async owner => rows.get(owner),
      save: async (owner, value) => {
        rows.set(owner, value)
      },
      list: async () => [...rows].map(([owner, configuration]) => ({ owner, configuration })),
      remove: async owner => {
        rows.delete(owner)
      },
    },
    async () => {},
    {
      view: async () => undefined,
      restart: () => {
        restarts++
      },
    },
  )
  const input = { enabled: true, commands: [{ command: 'search', blocked: [] }], variables: [] }
  await service.save(actor, 'skill:search', input)
  expect(await service.view(actor, 'skill:search')).toMatchObject({ awaitingPreparation: true })
  const prepared = await service.reprepare(actor, 'skill:search')
  expect(prepared.awaitingPreparation).toBe(false)
  expect(prepared).not.toHaveProperty('approvedContribution')
  expect(restarts).toBe(1)
  expect(rows.get('skill:search')?.approvedContribution).toBe('selected-receipt')
  await service.save(actor, 'skill:search', input)
  expect(rows.get('skill:search')?.approvedContribution).toBe('selected-receipt')
  preparationApproval = 'next-same-bytes-receipt'
  expect((await service.view(actor, 'skill:search')).awaitingPreparation).toBe(true)
  expect(await service.contributionPreview('search', { purpose: 'Update' })).not.toHaveProperty('approvedContribution')
})

it('selects ready runtime dependencies while allowing credential changes on an existing migration fallback', async () => {
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
  let config: ExecutionConfiguration = { enabled: true, commands: [{ command: 'news', blocked: [] }], variables: [], runtimeDependencies: ['migration'] }
  const checked: string[][] = []
  const service = new ExecutionAdministration(
    { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    { get: id => ({ id, version: 'v1' }), owns: async () => true },
    {
      get: async () => config,
      list: async () => [{ owner: 'skill:news', configuration: config }],
      remove: async () => {},
      save: async (_, value) => {
        config = value
      },
    },
    async () => {},
    undefined,
    undefined,
    {
      readReady: async names => {
        checked.push([...names])
        if (names.includes('unavailable')) throw new Error('not ready')
        return []
      },
    },
  )
  await service.save(actor, 'skill:news', { ...config, variables: [{ name: 'KEY', value: 'new', secret: true }] })
  expect(checked).toEqual([[]])
  await expect(service.save(actor, 'skill:news', { ...config, runtimeDependencies: ['unavailable'] })).rejects.toThrow('not ready')
  await expect(service.save(actor, 'skill:news', { ...config, prepare: 'install-new' })).rejects.toMatchObject({ code: 'execution-config-invalid' })
  expect(config.runtimeDependencies).toEqual(['migration'])
})

it('keeps optional backend templates off when skipped and enables one backend through save, update and rollback', async () => {
  const rows = new Map<string, ExecutionConfiguration>()
  const service = new ExecutionAdministration(
    { get: async () => undefined },
    { get: id => ({ id, version: 'v1' }), owns: async () => true },
    {
      get: async owner => rows.get(owner),
      save: async (owner, value) => {
        rows.set(owner, value)
      },
      list: async () => [...rows].map(([owner, configuration]) => ({ owner, configuration })),
      remove: async owner => {
        rows.delete(owner)
      },
    },
    async () => {},
  )
  const template = {
    commands: [{ command: 'scripts/image.py', blocked: [] }],
    variables: ['BACKEND', 'FIRST_KEY', 'SECOND_KEY'],
    optionalVariables: ['BACKEND', 'FIRST_KEY', 'SECOND_KEY'],
    runtimeDependencies: [],
  }
  await service.commitSuiteExecution('suite:images', 'skill:images', template, {})
  expect(rows.get('skill:images')?.enabled).toBe(false)
  expect(await service.suiteMissingCredentials('skill:images')).toEqual([])
  await service.saveSuiteCredentials('suite:images', 'skill:images', { BACKEND: 'first', FIRST_KEY: 'platform-only-secret' })
  expect(rows.get('skill:images')?.enabled).toBe(true)
  const snapshot = (await service.suiteOwnedSnapshot('suite:images', 'skill:images'))!
  await service.updateSuiteExecution('suite:images', 'skill:images', { ...template, optionalVariables: ['SECOND_KEY'] })
  await service.restoreSuiteUpdate('suite:images', snapshot)
  expect(rows.get('skill:images')).toMatchObject({ enabled: true, optionalVariables: template.optionalVariables })
  await service.saveSuiteCredentials('suite:images', 'skill:images', { BACKEND: '', FIRST_KEY: '' })
  expect(rows.get('skill:images')?.enabled).toBe(false)
})

it('does not enable a skipped optional template with a replaced manual credential retained only for rollback', async () => {
  const rows = new Map<string, ExecutionConfiguration>([
    [
      'skill:images',
      {
        enabled: true,
        commands: [{ command: 'scripts/image.py', blocked: [] }],
        variables: [{ name: 'LEGACY_KEY', value: 'prior-only-secret', secret: true }],
      },
    ],
  ])
  const service = new ExecutionAdministration(
    { get: async () => undefined },
    { get: id => ({ id, version: 'v1' }), owns: async () => true },
    {
      get: async owner => rows.get(owner),
      save: async (owner, value) => {
        rows.set(owner, value)
      },
      list: async () => [...rows].map(([owner, configuration]) => ({ owner, configuration })),
      remove: async owner => {
        rows.delete(owner)
      },
    },
    async () => {},
  )
  const replacing = (await service.suiteExecutionSnapshot('skill:images'))!
  await service.commitSuiteExecution(
    'suite:images',
    'skill:images',
    { commands: [{ command: 'scripts/image.py', blocked: [] }], variables: ['BACKEND_KEY'], optionalVariables: ['BACKEND_KEY'], runtimeDependencies: [] },
    {},
    [replacing],
  )
  await service.finalizeSuiteExecutions('suite:images', [{ owner: 'skill:images', variables: ['BACKEND_KEY'] }])
  expect(rows.get('skill:images')).toMatchObject({ enabled: false, variables: [{ name: 'BACKEND_KEY', value: '' }] })
})

it('keeps existing credentials when a suite adopts backend declarations and never activates them implicitly', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const owner = 'skill:design',
    origin = 'suite:design'
  let row: ExecutionConfiguration | undefined
  const service = new ExecutionAdministration(
    { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    { get: id => ({ id, version: 'v1' }), owns: async () => true },
    {
      get: async () => row,
      save: async (_, value) => {
        row = value
      },
      list: async () => (row ? [{ owner, configuration: row }] : []),
      remove: async () => {
        row = undefined
      },
    },
    async () => {},
  )
  const template = {
    commands: [{ command: 'draw', blocked: [] }],
    variables: ['FIRST_KEY', 'SHARED_KEY', 'MODEL', 'RETIRED_KEY', 'LATER_KEY'],
    runtimeDependencies: [],
  }
  await service.commitSuiteExecution(origin, owner, template, {
    FIRST_KEY: 'fixture-old-first',
    SHARED_KEY: 'fixture-old-shared',
    MODEL: 'fixture-old-model',
    RETIRED_KEY: 'fixture-retired',
    LATER_KEY: 'fixture-later',
  })
  const label = { en: 'Image', 'zh-CN': '生图' }
  const services = installServiceDefinition({ id: 'design', version: '2.0.0' }, [
    {
      id: 'image',
      label,
      commands: ['draw'],
      backends: ['first', 'second'].map(id => ({
        id,
        label,
        selector: { kind: 'option' as const, name: '--backend', value: id },
        fields: [
          ...(id === 'first' ? [{ name: 'FIRST_KEY', type: 'secret' as const, required: true }] : []),
          { name: 'SHARED_KEY', type: 'secret' as const, required: true },
          { name: 'MODEL', type: 'text' as const, required: false },
        ],
      })),
    },
  ])!
  await service.updateSuiteExecution(origin, owner, { ...template, services, variables: ['LATER_KEY'], optionalVariables: ['LATER_KEY'] })
  await service.finalizeSuiteExecutions(origin, [{ owner, variables: ['LATER_KEY'] }])
  const retained = await service.services(actor, owner)
  expect(retained.retainedLegacyFields).toEqual(['SHARED_KEY', 'MODEL', 'RETIRED_KEY'])
  expect(retained.slots[0]?.backends[0]).toMatchObject({
    enabled: false,
    fields: [
      { name: 'FIRST_KEY', configured: true },
      { name: 'SHARED_KEY', configured: false },
      { name: 'MODEL', configured: false },
    ],
  })
  expect(JSON.stringify(retained)).not.toContain('fixture-old-')
  expect(await service.suiteExecutionStatus(owner)).toMatchObject({ enabled: false })
  const adopted = await service.saveServices(actor, owner, retained.revision, {
    slot: 'image',
    backend: 'second',
    action: 'adopt-legacy',
    field: 'SHARED_KEY',
    confirmed: true,
  })
  expect(adopted.slots[0]?.backends[1]).toMatchObject({ enabled: false, complete: true })
  expect(adopted.retainedLegacyFields).toContain('SHARED_KEY')
  const first = await service.saveServices(actor, owner, adopted.revision, {
    slot: 'image',
    backend: 'first',
    action: 'adopt-legacy',
    field: 'SHARED_KEY',
    confirmed: true,
  })
  expect(first.retainedLegacyFields).not.toContain('SHARED_KEY')
  expect(first.slots[0]?.backends[0]).toMatchObject({ enabled: false, complete: true })
  const active = await service.saveServices(actor, owner, first.revision, { slot: 'image', backend: 'second', action: 'enable' })
  expect(active.slots[0]?.backends[1]).toMatchObject({ enabled: true })
  const [initial] = services.slots
  const expanded = installServiceDefinition({ id: 'design', version: '3.0.0' }, [
    {
      ...initial!,
      backends: [
        ...initial!.backends,
        {
          id: 'later',
          label,
          selector: { kind: 'option' as const, name: '--backend', value: 'later' },
          fields: [{ name: 'LATER_KEY', type: 'secret' as const, required: true }],
        },
      ],
    },
  ])!
  await service.updateSuiteExecution(origin, owner, {
    ...template,
    commands: [{ command: 'draw', source: 'scripts/new.sh', blocked: [] }],
    services: expanded,
    variables: [],
  })
  await service.finalizeSuiteExecutions(origin, [{ owner, variables: [] }])
  const after = await service.services(actor, owner)
  expect(after.slots[0]?.backends[1]).toMatchObject({ enabled: false, complete: true })
  expect(after.slots[0]?.backends[2]).toMatchObject({ enabled: false, complete: true })
  const removed = await service.saveServices(actor, owner, after.revision, { action: 'discard-legacy', field: 'RETIRED_KEY', confirmed: true })
  expect(removed.retainedLegacyFields).toEqual(['MODEL'])

  await service.detachSuiteExecution(origin, owner)
  await service.save(actor, owner, { enabled: false, commands: [], variables: [] })
  expect((await service.services(actor, owner)).retainedLegacyFields).toEqual(['MODEL'])
  expect(await service.view(actor, owner)).toMatchObject({ enabled: false })
  await expect(service.saveServices(actor, owner, retained.revision, { slot: 'image', backend: 'second', action: 'enable' })).rejects.toMatchObject({
    code: 'execution-config-invalid',
  })
  row = undefined
  await service.save(actor, owner, { enabled: true, commands: template.commands, variables: [{ name: 'FIRST_KEY', value: 'fixture-manual', secret: true }] })
  const takeover = (await service.suiteExecutionSnapshot(owner))!
  await service.commitSuiteExecution(origin, owner, { ...template, services, variables: [] }, {}, [takeover])
  await service.finalizeSuiteExecutions(origin, [{ owner, variables: [] }])
  const installed = await service.services(actor, owner)
  expect(installed.slots[0]?.backends[0]).toMatchObject({
    enabled: false,
    fields: [{ name: 'FIRST_KEY', configured: true }, expect.anything(), expect.anything()],
  })
  expect(JSON.stringify(installed)).not.toContain('fixture-manual')
  expect((row as ExecutionConfiguration | undefined)?.services?.ownerVersion).toBe('v1')
  await service.detachSuiteExecution(origin, owner)
  const detached = (await service.suiteExecutionSnapshot(owner))!
  const otherOrigin = 'suite:other'
  const legacy = { ...template, variables: ['OLD_KEY'] }
  await service.commitSuiteExecution(otherOrigin, owner, legacy, { OLD_KEY: 'fixture-owner-other' }, [detached])
  await expect(service.services(actor, owner)).rejects.toMatchObject({ code: 'suite-not-installed' })
  const otherDefinition = installServiceDefinition({ id: 'other', version: '2.0.0' }, services.slots)!
  await service.updateSuiteExecution(otherOrigin, owner, { ...legacy, services: otherDefinition })
  const identity = { id: 'other', version: '3.0.0', contentHash: 'new-definition-digest' }
  await service.updateSuiteExecution(otherOrigin, owner, { ...legacy, variables: [], serviceIdentity: identity })
  await service.finalizeSuiteExecutions(otherOrigin, [{ owner, variables: [] }])
  expect(await service.services(actor, owner)).toMatchObject({ identity, slots: [], retainedLegacyFields: ['OLD_KEY'] })
})

it('refuses to discard or transfer protected values when a different skill owner delegates the same command', async () => {
  const owner = 'skill:other'
  const previous: ExecutionConfiguration = {
    enabled: true,
    commands: [{ command: 'draw', blocked: [] }],
    variables: [{ name: 'TEAM_KEY', value: 'fictional-old-key', secret: true }],
  }
  const rows = new Map([[owner, previous]])
  const service = new ExecutionAdministration(
    { get: async () => undefined },
    { get: id => ({ id, version: 'v1' }), owns: async () => true },
    {
      get: async id => rows.get(id),
      list: async () => [...rows].map(([id, configuration]) => ({ owner: id, configuration })),
      save: async (id, configuration) => {
        rows.set(id, configuration)
      },
      remove: async id => {
        rows.delete(id)
      },
    },
    async () => {},
  )
  const label = { en: 'Images', 'zh-CN': '生图' }
  const services = installServiceDefinition({ id: 'design', version: '1.0.0' }, [
    {
      id: 'image',
      label,
      commands: ['draw'],
      backends: [{ id: 'api', label, fields: [{ name: 'TEAM_KEY', type: 'secret' as const, required: true }] }],
    },
  ])!
  const confirmation = (await service.suiteExecutionSnapshot(owner))!
  await expect(
    service.commitSuiteExecution('suite:design', 'skill:design', { commands: previous.commands, variables: [], runtimeDependencies: [], services }, {}, [
      confirmation,
    ]),
  ).rejects.toMatchObject({ code: 'suite-replace-unconfirmed' })
  expect([...rows]).toEqual([[owner, previous]])
})
