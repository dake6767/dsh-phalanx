import { expect, it } from 'vitest'
import type { SuiteCatalogEntry, SuiteCatalogSuiteEntry } from '../src/domain/suite-catalog.js'
import { actor, delegatedPreset, fixture, suitePreset, text } from './fixtures/suite-catalog.js'

/** A manual 0.1.15-style setup: CLI dependency, same-repository skill with grants and publication, and delegated execution. */
function manualSetup(f: ReturnType<typeof fixture>, url = 'https://git.example/repository') {
  const version = {
    id: 'manual-version',
    identity: 'manual',
    directory: '/private',
    mountedPath: '/mounted',
    commands: ['suite-cli'],
    commandPaths: {},
    pathDirectories: ['bin'],
    bytes: 1,
    isolated: true,
    checks: [],
    log: '',
  }
  f.dependencyRows.set('my-cli', {
    name: 'my-cli',
    source: 'manual',
    prepareCommand: 'manual install',
    pathDirectories: ['bin'],
    stage: 'ready',
    updatedAt: 0,
    log: '',
    checks: [],
    current: version,
  })
  f.libraryRows.set('one', {
    name: 'one',
    description: 'manual one',
    hash: 'manual-hash',
    importedAt: 0,
    published: true,
    runtimeDependencies: ['my-cli'],
    source: { url, subpath: 'skills', ref: 'main', path: 'skills/one/SKILL.md', commit: 'c'.repeat(40), contentHash: 'manual-hash' },
  })
  f.granted.set('team', ['one'])
  f.choices.set('m', ['one'])
  f.executionRows.set('skill:one', {
    enabled: true,
    commands: [{ command: 'suite-cli', blocked: [] }],
    variables: [{ name: 'SUITE_KEY', secret: true, value: 'saved-secret' }],
    runtimeDependencies: ['my-cli'],
  })
}

it('lists manual entries the catalog version replaces and refuses to install without confirmation', async () => {
  const f = fixture(delegatedPreset())
  manualSetup(f)
  const preview = await f.suites.installPreview(actor, 'fixture-suite')
  expect(preview.reason).toBeUndefined()
  expect(preview.replacements).toEqual([
    { kind: 'runtime-dependency', name: 'my-cli' },
    { kind: 'skill', name: 'one' },
  ])
  await expect(f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).rejects.toThrow(
    expect.objectContaining({ code: 'suite-replace-unconfirmed' }),
  )
  expect(f.state.installs).toHaveLength(0)
  expect(f.dependencyRows.get('my-cli')?.source).toBe('manual')
})

it('replaces the manual CLI and skill once, keeping references, grants, publication, selections and credentials', async () => {
  const f = fixture(delegatedPreset())
  manualSetup(f)
  await f.suites.install(actor, {
    id: 'fixture-suite',
    requestId: 'request-aaaaaaaaaaaa1',
    replace: [
      { kind: 'runtime-dependency', name: 'my-cli' },
      { kind: 'skill', name: 'one' },
    ],
  })
  await f.settled('installed')
  expect([...f.dependencyRows.keys()]).toEqual(['my-cli'])
  expect(f.dependencyRows.get('my-cli')).toMatchObject({
    source: 'suite-catalog',
    managedOrigin: 'suite:fixture-suite',
    previous: { id: 'manual-version' },
    prepareCommand: 'install-suite-cli',
  })
  // Like MiniMax, the suite skill reaches its CLI only through delegated execution, so the catalog definition decides its PATH.
  expect(f.libraryRows.get('one')).toMatchObject({ suiteOrigin: 'suite:fixture-suite', hash: 'hash-one', published: true })
  expect(f.libraryRows.get('one')?.runtimeDependencies).toBeUndefined()
  expect(f.granted.get('team')).toEqual(['one'])
  expect(f.choices.get('m')).toEqual(['one'])
  expect(f.executionRows.get('skill:one')).toMatchObject({
    suiteOrigin: 'suite:fixture-suite',
    enabled: true,
    runtimeDependencies: ['my-cli'],
    commands: [{ command: 'suite-cli', blocked: ['auth', 'config'] }],
    variables: [{ name: 'SUITE_KEY', value: 'saved-secret' }],
  })
  expect(f.record()).toMatchObject({
    replaced: [
      { kind: 'runtime-dependency', name: 'my-cli' },
      { kind: 'skill', name: 'one' },
    ],
  })
  expect(f.record()).not.toHaveProperty('replacing')
  expect(JSON.stringify(f.state)).not.toContain('saved-secret')
})

it('restores every replaced manual entry when the install fails after the takeover', async () => {
  const f = fixture(delegatedPreset())
  manualSetup(f)
  f.failPack()
  const before = {
    dependency: structuredClone(f.dependencyRows.get('my-cli')),
    skill: structuredClone(f.libraryRows.get('one')),
    execution: structuredClone(f.executionRows.get('skill:one')),
  }
  await f.suites.install(actor, {
    id: 'fixture-suite',
    requestId: 'request-aaaaaaaaaaaa1',
    replace: [
      { kind: 'runtime-dependency', name: 'my-cli' },
      { kind: 'skill', name: 'one' },
    ],
  })
  await f.settled('failed')
  expect(f.dependencyRows.get('my-cli')).toEqual(before.dependency)
  expect(f.libraryRows.get('one')).toEqual(before.skill)
  expect(f.executionRows.get('skill:one')).toEqual(before.execution)
  expect(f.granted.get('team')).toEqual(['one'])
  expect(f.choices.get('m')).toEqual(['one'])
  expect(f.record()).not.toHaveProperty('replacing')
})

it('ends interrupted takeover preparation while keeping every original manual fact unchanged', async () => {
  const f = fixture(delegatedPreset())
  manualSetup(f)
  const before = {
    dependency: structuredClone(f.dependencyRows.get('my-cli')),
    skill: structuredClone(f.libraryRows.get('one')),
    execution: structuredClone(f.executionRows.get('skill:one')),
  }
  f.state = {
    installs: [
      { id: 'fixture-suite', version: '1', status: 'installing', entries: [], requestId: 'request-aaaaaaaaaaaa1', updatedAt: 0, log: 'Preparing takeover.' },
    ],
  }
  await f.suites.recover()
  expect(f.dependencyRows.get('my-cli')).toEqual(before.dependency)
  expect(f.libraryRows.get('one')).toEqual(before.skill)
  expect(f.executionRows.get('skill:one')).toEqual(before.execution)
  expect(f.record()).toMatchObject({ status: 'failed', failureCode: 'interrupted' })
  expect(f.record()).not.toHaveProperty('replacing')
})

it('marks same-name skills from another repository as conflicts instead of replacing them', async () => {
  const f = fixture(delegatedPreset())
  manualSetup(f, 'https://git.example/other')
  const preview = await f.suites.installPreview(actor, 'fixture-suite')
  expect(preview).toMatchObject({ reason: 'skill-conflicts', conflicts: ['one'], creates: [] })
  await expect(f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).rejects.toThrow(
    expect.objectContaining({ code: 'suite-skill-conflict' }),
  )
  expect(f.libraryRows.get('one')?.hash).toBe('manual-hash')
})

it('blocks an install whose CLI commands an MCP catalog dependency provides', async () => {
  const f = fixture()
  f.dependencyRows.set('mcp-cli', {
    name: 'mcp-cli',
    source: 'mcp-catalog',
    managedOrigin: 'mcp:x',
    prepareCommand: 'x',
    pathDirectories: ['bin'],
    stage: 'ready',
    updatedAt: 0,
    log: '',
    checks: [],
    current: {
      id: 'v',
      identity: 'x',
      directory: '/p',
      mountedPath: '/m',
      commands: ['suite-cli'],
      commandPaths: {},
      pathDirectories: ['bin'],
      bytes: 1,
      isolated: true,
      checks: [],
      log: '',
    },
  })
  expect(await f.suites.installPreview(actor, 'fixture-suite')).toMatchObject({ reason: 'dependency-conflicts', dependencyConflicts: ['mcp-cli'] })
  await expect(f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).rejects.toThrow(
    expect.objectContaining({ code: 'suite-dependency-conflict' }),
  )
  expect(f.dependencyRows.get('mcp-cli')?.source).toBe('mcp-catalog')
})

it('reuses a manual dependency for a shared catalog dependency without pinning it', async () => {
  const shared: SuiteCatalogEntry = {
    category: 'dependency',
    id: 'shared-tool',
    version: '1',
    title: text,
    description: text,
    source: text,
    items: [
      { kind: 'runtime-dependency', name: 'shared-tool', prepareCommands: { amd64: 'install-shared' }, pathDirectories: ['bin'], commands: ['shared-tool'] },
    ],
  }
  const base = suitePreset(['one']) as SuiteCatalogSuiteEntry
  const preset: SuiteCatalogSuiteEntry = {
    ...base,
    dependencies: ['shared-tool'],
    items: base.items.map(item =>
      item.kind === 'skill'
        ? { ...item, names: ['one'], catalogDependencies: ['shared-tool'] }
        : item.kind === 'skill-pack'
          ? { ...item, skills: ['one'] }
          : item,
    ),
  }
  const f = fixture(preset, [shared])
  f.dependencyRows.set('my-tool', {
    name: 'my-tool',
    source: 'manual',
    prepareCommand: 'manual',
    pathDirectories: ['bin'],
    stage: 'ready',
    updatedAt: 0,
    log: '',
    checks: [],
    current: {
      id: 'mine',
      identity: 'm',
      directory: '/p',
      mountedPath: '/m',
      commands: ['shared-tool'],
      commandPaths: {},
      pathDirectories: ['bin'],
      bytes: 1,
      isolated: true,
      checks: [],
      log: '',
    },
  })
  expect((await f.suites.installPreview(actor, 'fixture-suite')).dependencies).toEqual([{ id: 'shared-tool', action: 'manual', name: 'my-tool' }])
  await f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('installed')
  expect(f.libraryRows.get('one')?.runtimeDependencies).toEqual(['suite-cli', 'my-tool'])
  expect(f.dependencyRows.get('my-tool')).toMatchObject({ source: 'manual', current: { id: 'mine' } })
  expect(f.state.installs.find(row => row.id === 'shared-tool')).toBeUndefined()
  expect((await f.suites.catalog(actor)).installations.find(row => row.id === 'fixture-suite')).toMatchObject({
    manualDependencies: [{ id: 'shared-tool', name: 'my-tool' }],
  })

  // Switching to the catalog version is a confirmed replace task; the name, and so every reference, carries over.
  expect((await f.suites.installPreview(actor, 'shared-tool')).replacements).toEqual([{ kind: 'runtime-dependency', name: 'my-tool' }])
  await expect(f.suites.install(actor, { id: 'shared-tool', requestId: 'request-aaaaaaaaaaaa2' })).rejects.toThrow(
    expect.objectContaining({ code: 'suite-replace-unconfirmed' }),
  )
  await f.suites.install(actor, { id: 'shared-tool', requestId: 'request-aaaaaaaaaaaa3', replace: [{ kind: 'runtime-dependency', name: 'my-tool' }] })
  await expect.poll(() => f.state.installs.find(row => row.id === 'shared-tool')?.status).toBe('installed')
  expect(f.dependencyRows.get('my-tool')).toMatchObject({
    source: 'suite-catalog',
    managedOrigin: 'suite:shared-tool',
    current: { id: 'version-shared-tool' },
    previous: { id: 'mine' },
  })
  expect(f.libraryRows.get('one')?.runtimeDependencies).toEqual(['suite-cli', 'my-tool'])
  expect(f.record()?.manualDependencies).toBeUndefined()
  expect((await f.suites.uninstallPreview(actor, 'fixture-suite')).dependencies).toEqual([{ id: 'shared-tool', references: [] }])
  expect((await f.suites.uninstallPreview(actor, 'shared-tool')).blocked.length).toBeGreaterThan(0)
})

it('refuses a confirmation that no longer matches the plan, and a takeover of rows changed while it prepared', async () => {
  const f = fixture(delegatedPreset())
  manualSetup(f)
  // Confirming only part of what the preview lists is not a confirmation.
  await expect(f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', replace: [{ kind: 'skill', name: 'one' }] })).rejects.toThrow(
    expect.objectContaining({ code: 'suite-replace-unconfirmed' }),
  )
  await expect(f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa2', replace: true })).rejects.toThrow(
    expect.objectContaining({ code: 'suite-catalog-invalid' }),
  )
  const before = structuredClone(f.dependencyRows.get('my-cli'))
  await f.suites.install(actor, {
    id: 'fixture-suite',
    requestId: 'request-aaaaaaaaaaaa3',
    replace: [
      { kind: 'runtime-dependency', name: 'my-cli' },
      { kind: 'skill', name: 'one' },
    ],
  })
  // The administrator edits the manual dependency while the suite prepares: it is not taken over, and not rolled back.
  const edited = { ...before!, prepareCommand: 'edited install', updatedAt: 5 }
  f.dependencyRows.set('my-cli', edited)
  await f.settled('failed')
  expect(f.record()).toMatchObject({ failureCode: 'suite-replace-unconfirmed' })
  expect(f.dependencyRows.get('my-cli')).toEqual(edited)
  expect(f.libraryRows.get('one')).toMatchObject({ hash: 'manual-hash' })
  expect(f.libraryRows.get('one')?.suiteOrigin).toBeUndefined()
  expect(f.executionRows.get('skill:one')).toMatchObject({ enabled: true, variables: [{ name: 'SUITE_KEY', value: 'saved-secret' }] })
  expect(f.executionRows.get('skill:one')?.suiteOrigin).toBeUndefined()
})

it('never takes over a manual MCP service dependency and blocks shared dependencies other owners provide', async () => {
  const f = fixture(delegatedPreset())
  f.dependencyRows.set('mcp-own', {
    name: 'mcp-own',
    source: 'manual',
    managedOrigin: 'mcp:service',
    prepareCommand: 'x',
    pathDirectories: ['bin'],
    stage: 'ready',
    updatedAt: 0,
    log: '',
    checks: [],
    current: {
      id: 'v',
      identity: 'x',
      directory: '/p',
      mountedPath: '/m',
      commands: ['suite-cli'],
      commandPaths: {},
      pathDirectories: ['bin'],
      bytes: 1,
      isolated: true,
      checks: [],
      log: '',
    },
  })
  expect(await f.suites.installPreview(actor, 'fixture-suite')).toMatchObject({ reason: 'dependency-conflicts', dependencyConflicts: ['mcp-own'] })
  expect((await f.suites.installPreview(actor, 'fixture-suite')).replacements).toBeUndefined()

  const shared: SuiteCatalogEntry = {
    category: 'dependency',
    id: 'shared-tool',
    version: '1',
    title: text,
    description: text,
    source: text,
    items: [
      {
        kind: 'runtime-dependency',
        name: 'shared-tool',
        prepareCommands: { amd64: 'install-shared' },
        pathDirectories: ['bin'],
        commands: ['shared-tool', 'shared-probe'],
      },
    ],
  }
  const base = suitePreset(['one']) as SuiteCatalogSuiteEntry
  const g = fixture({ ...base, dependencies: ['shared-tool'] }, [shared])
  // A manual row providing only part of the commands is neither reused nor silently installed next to.
  g.dependencyRows.set('partial', {
    name: 'partial',
    source: 'manual',
    prepareCommand: 'x',
    pathDirectories: ['bin'],
    stage: 'ready',
    updatedAt: 0,
    log: '',
    checks: [],
    current: {
      id: 'p',
      identity: 'x',
      directory: '/p',
      mountedPath: '/m',
      commands: ['shared-probe'],
      commandPaths: {},
      pathDirectories: ['bin'],
      bytes: 1,
      isolated: true,
      checks: [],
      log: '',
    },
  })
  expect(await g.suites.installPreview(actor, 'fixture-suite')).toMatchObject({ reason: 'dependency-conflicts', dependencyConflicts: ['partial'] })
  await expect(g.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).rejects.toThrow(
    expect.objectContaining({ code: 'suite-dependency-conflict' }),
  )
})

it('reports a manual skill pack with the suite pack name before installing', async () => {
  const f = fixture()
  f.packRows.set('fixture-suite', { name: 'fixture-suite', description: 'manual', skills: [], instructions: '', published: false })
  expect(await f.suites.installPreview(actor, 'fixture-suite')).toMatchObject({ reason: 'pack-conflicts', packConflicts: ['fixture-suite'], creates: [] })
  await expect(f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).rejects.toThrow(
    expect.objectContaining({ code: 'skill-pack-invalid' }),
  )
})

it('takes over the manual configuration of another replaced skill delegating the same command and keeps extra variables until success', async () => {
  const preset = delegatedPreset() as SuiteCatalogSuiteEntry
  const twoSkills: SuiteCatalogSuiteEntry = {
    ...preset,
    items: preset.items.map(item =>
      item.kind === 'skill' ? { ...item, names: ['one', 'two'] } : item.kind === 'skill-pack' ? { ...item, skills: ['one', 'two'] } : item,
    ),
  }
  const f = fixture(twoSkills)
  manualSetup(f)
  f.libraryRows.set('two', { ...f.libraryRows.get('one')!, name: 'two', hash: 'manual-two' })
  // The 0.1.15 setup put the CLI on skill two, with an extra variable the suite does not declare.
  f.executionRows.delete('skill:one')
  f.executionRows.set('skill:two', {
    enabled: true,
    commands: [{ command: 'suite-cli', blocked: [] }],
    variables: [
      { name: 'SUITE_KEY', secret: true, value: 'saved-secret' },
      { name: 'PROXY_TOKEN', secret: true, value: 'proxy' },
    ],
    runtimeDependencies: ['my-cli'],
  })
  const before = structuredClone(f.executionRows.get('skill:two'))
  expect((await f.suites.installPreview(actor, 'fixture-suite')).reason).toBeUndefined()
  const replace = [
    { kind: 'runtime-dependency' as const, name: 'my-cli' },
    { kind: 'skill' as const, name: 'one' },
    { kind: 'skill' as const, name: 'two' },
  ]
  f.failPack()
  await f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', replace })
  await f.settled('failed')
  expect(f.executionRows.get('skill:two')).toEqual(before)
  expect(f.executionRows.has('skill:one')).toBe(false)

  const g = fixture(twoSkills)
  manualSetup(g)
  g.libraryRows.set('two', { ...g.libraryRows.get('one')!, name: 'two', hash: 'manual-two' })
  g.executionRows.delete('skill:one')
  g.executionRows.set('skill:two', structuredClone(before!))
  await g.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', replace })
  await g.settled('installed')
  // The suite configuration on skill one carries the saved credential; skill two's manual configuration is gone.
  expect(g.executionRows.get('skill:one')).toMatchObject({
    suiteOrigin: 'suite:fixture-suite',
    enabled: true,
    variables: [{ name: 'SUITE_KEY', value: 'saved-secret' }],
  })
  expect(g.executionRows.has('skill:two')).toBe(false)
})

it('leaves no owned replacement or restore checkpoint after a rejected takeover and keeps the originals through recovery', async () => {
  const f = fixture(delegatedPreset())
  manualSetup(f)
  f.failPack()
  const before = {
    dependency: structuredClone(f.dependencyRows.get('my-cli')),
    skill: structuredClone(f.libraryRows.get('one')),
    execution: structuredClone(f.executionRows.get('skill:one')),
  }
  await f.suites.install(actor, {
    id: 'fixture-suite',
    requestId: 'request-aaaaaaaaaaaa1',
    replace: [
      { kind: 'runtime-dependency', name: 'my-cli' },
      { kind: 'skill', name: 'one' },
    ],
  })
  await f.settled('failed')
  expect(f.record()).not.toHaveProperty('replacing')
  expect(f.libraryRows.get('one')).toEqual(before.skill)
  expect(f.dependencyRows.get('my-cli')).toEqual(before.dependency)
  expect(f.executionRows.get('skill:one')).toEqual(before.execution)
  await f.suites.recover()
  expect(f.libraryRows.get('one')).toEqual(before.skill)
  expect(f.dependencyRows.get('my-cli')).toEqual(before.dependency)
  expect(f.executionRows.get('skill:one')).toEqual(before.execution)
})

it('treats a recorded manual skill deleted during the task as changed, so a failure cannot bring it back', async () => {
  const f = fixture(delegatedPreset())
  manualSetup(f)
  await f.suites.install(actor, {
    id: 'fixture-suite',
    requestId: 'request-aaaaaaaaaaaa1',
    replace: [
      { kind: 'runtime-dependency', name: 'my-cli' },
      { kind: 'skill', name: 'one' },
    ],
  })
  f.libraryRows.delete('one')
  await f.settled('failed')
  expect(f.record()).toMatchObject({ failureCode: 'suite-replace-unconfirmed' })
  expect(f.libraryRows.has('one')).toBe(false)
  expect(f.dependencyRows.get('my-cli')?.source).toBe('manual')
})
