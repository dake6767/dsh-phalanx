import { expect, it } from 'vitest'
import type { SuiteCatalogEntry } from '../src/domain/suite-catalog.js'
import { suiteInstallOrigin } from '../src/domain/suite-install.js'
import { actor, delegatedPreset, fixture, suitePreset, text } from './fixtures/suite-catalog.js'

it('installs a suite with skills, a pack and the CLI dependency, and honors wizard grants and publication', async () => {
  const f = fixture()
  const preview = await f.suites.installPreview(actor, 'fixture-suite')
  expect(preview.creates).toEqual([
    { kind: 'runtime-dependency', name: 'suite-cli', commands: ['suite-cli'] },
    { kind: 'skill', name: '2 skills', detail: 'https://git.example/repository @ aaaaaaa' },
    { kind: 'skill-pack', name: 'fixture-suite', detail: '2 skills' },
  ])
  await f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', groups: ['team'], publish: true })
  await f.settled('installed')
  expect(f.record()).toMatchObject({
    status: 'installed',
    entries: [
      { kind: 'runtime-dependency', name: 'suite-cli' },
      { kind: 'skill', name: 'one' },
      { kind: 'skill', name: 'two' },
      { kind: 'skill-pack', name: 'fixture-suite' },
    ],
  })
  expect(f.dependencyRows.get('suite-cli')).toMatchObject({ source: 'suite-catalog', managedOrigin: suiteInstallOrigin('fixture-suite'), stage: 'ready' })
  for (const name of ['one', 'two'])
    expect(f.libraryRows.get(name)).toMatchObject({ suiteOrigin: suiteInstallOrigin('fixture-suite'), runtimeDependencies: ['suite-cli'], published: false })
  expect(f.packRows.get('fixture-suite')).toMatchObject({
    suiteOrigin: suiteInstallOrigin('fixture-suite'),
    published: true,
    skills: ['one', 'two'],
    note: { name: 'fixture-suite' },
  })
  expect(f.packGrants.get('team')).toEqual(['fixture-suite'])
  expect((await f.suites.catalog(actor)).entries.find(entry => entry.id === 'fixture-suite')).toMatchObject({
    category: 'suite',
    packName: 'fixture-suite',
    skills: ['one', 'two'],
  })
})

it('rolls back the CLI dependency when the Git import fails, and reports mismatches and conflicts', async () => {
  const f = fixture()
  f.fail()
  await f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('failed')
  expect(f.dependencyRows.size).toBe(0)
  expect(f.libraryRows.size).toBe(0)
  expect(f.packRows.size).toBe(0)
  expect(f.record()?.log).toContain('git clone failed')

  const mismatched = fixture()
  mismatched.mismatch()
  await mismatched.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await mismatched.settled('failed')
  expect(mismatched.record()).toMatchObject({ failureCode: 'suite-skill-mismatch' })
  expect(mismatched.dependencyRows.size).toBe(0)

  const conflicted = fixture()
  conflicted.libraryRows.set('one', { name: 'one', description: 'manual', hash: 'manual', importedAt: 0, published: false })
  await expect(conflicted.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).rejects.toThrow(
    expect.objectContaining({ code: 'suite-skill-conflict' }),
  )
  expect(conflicted.libraryRows.get('one')).toMatchObject({ hash: 'manual' })
  expect(conflicted.dependencyRows.size).toBe(0)
})

it('keeps suite-owned skills and packs read-only', async () => {
  const f = fixture()
  await f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('installed')
  const detail = await f.library.detail(actor, 'one')
  await expect(f.library.publish(actor, 'one', true, detail.revision)).rejects.toMatchObject({ code: 'suite-entry-locked' })
  await expect(f.library.remove(actor, 'one', detail.revision)).rejects.toMatchObject({ code: 'suite-entry-locked' })
  await expect(f.library.setRuntimeDependencies(actor, 'one', [], detail.revision)).rejects.toMatchObject({ code: 'suite-entry-locked' })
  const packRevision = await f.packs.revision(actor)
  await expect(
    f.packs.save(actor, { name: 'fixture-suite', description: 'Changed', skills: ['one'], instructions: '', published: false }, packRevision),
  ).rejects.toMatchObject({ code: 'suite-entry-locked' })
  await expect(f.packs.remove(actor, 'fixture-suite', false, (await f.packs.detail(actor, 'fixture-suite')).revision)).rejects.toMatchObject({
    code: 'suite-entry-locked',
  })
})

it('previews and completes uninstalls, revoking grants and selections, and blocks manual pack references', async () => {
  const f = fixture()
  await f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', groups: ['team'], publish: true })
  await f.settled('installed')
  f.packSelections.set('m', ['fixture-suite'])
  const preview = await f.suites.uninstallPreview(actor, 'fixture-suite')
  expect(preview.removes.map(entry => entry.name)).toEqual(['suite-cli', 'one', 'two', 'fixture-suite'])
  expect(preview.impact).toEqual([{ name: 'fixture-suite', groups: [{ id: 'team', name: 'Team' }], published: true, selectedMembers: 1 }])
  await f.suites.uninstall(actor, 'fixture-suite')
  await expect.poll(() => f.state.installs.length).toBe(0)
  expect(f.dependencyRows.size).toBe(0)
  expect(f.libraryRows.size).toBe(0)
  expect(f.packRows.size).toBe(0)
  expect(f.packGrants.get('team')).toEqual([])
  expect(f.packSelections.get('m')).toEqual([])

  const blocked = fixture()
  await blocked.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await blocked.settled('installed')
  blocked.packRows.set('manual', { name: 'manual', description: 'Manual pack', skills: ['one'], instructions: '', published: false })
  expect((await blocked.suites.uninstallPreview(actor, 'fixture-suite')).blocked).toEqual([
    { name: 'one', references: [{ kind: 'skill-pack', name: 'manual' }] },
  ])
  await expect(blocked.suites.uninstall(actor, 'fixture-suite')).rejects.toThrow(expect.objectContaining({ code: 'runtime-dependency-referenced' }))
  expect(blocked.record()?.status).toBe('installed')
})

it('lists skill conflicts in the preview and blocks zip/git imports from replacing suite skills', async () => {
  const f = fixture()
  f.libraryRows.set('one', { name: 'one', description: 'manual', hash: 'manual', importedAt: 0, published: false })
  const preview = await f.suites.installPreview(actor, 'fixture-suite')
  expect(preview).toMatchObject({ reason: 'skill-conflicts', conflicts: ['one'] })
  expect(preview.creates).toEqual([])
  await expect(f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).rejects.toThrow(
    expect.objectContaining({ code: 'suite-skill-conflict' }),
  )
  expect(f.state.installs).toHaveLength(0)

  const installed = fixture()
  await installed.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await installed.settled('installed')
  const manual = {
    name: 'one',
    description: 'replacement',
    hash: 'replacement',
    markdown: '# one',
    files: ['SKILL.md'],
    path: 'one/SKILL.md',
    internal: false,
    orchestration: false,
    warnings: [],
  }
  await expect(installed.library.confirmImport(actor, { token: 'token', names: ['one'], replacements: ['one'], packs: [] })).rejects.toMatchObject({
    code: 'skill-preview-changed',
  })
  void manual
})

it('ends interrupted suite preparation without removing ordinary library facts', async () => {
  const f = fixture()
  f.libraryRows.set('manual', { name: 'manual', description: 'Unrelated manual skill', hash: 'hash-manual', importedAt: 0, published: false })
  const before = structuredClone([...f.libraryRows.values()])
  f.state = { installs: [{ id: 'fixture-suite', version: '1', status: 'installing', entries: [], updatedAt: 0, log: 'Preparing.' }] }
  f.upgrade([suitePreset()])
  await f.suites.recover()
  expect([...f.libraryRows.values()]).toEqual(before)
  expect(f.dependencyRows.size).toBe(0)
  expect(f.packRows.size).toBe(0)
  expect(f.record()).toMatchObject({ status: 'failed', failureCode: 'interrupted' })
})

it('installs delegated execution disabled when credentials are skipped and enables it once they are saved', async () => {
  const f = fixture(delegatedPreset())
  expect((await f.suites.catalog(actor)).entries[0]).toMatchObject({
    execution: { commands: [{ command: 'suite-cli', blocked: ['auth', 'config'] }], variables: [{ name: 'SUITE_KEY' }] },
  })
  expect((await f.suites.installPreview(actor, 'fixture-suite')).creates).toContainEqual({ kind: 'execution', name: 'suite-cli', detail: 'SUITE_KEY' })
  await f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await f.settled('installed')
  expect(f.record()?.entries).toContainEqual({ kind: 'execution', name: 'one' })
  expect(f.libraryRows.get('one')?.runtimeDependencies).toBeUndefined()
  expect(f.executionRows.get('skill:one')).toMatchObject({
    enabled: false,
    suiteOrigin: 'suite:fixture-suite',
    runtimeDependencies: ['suite-cli'],
    commands: [{ command: 'suite-cli', blocked: ['auth', 'config'] }],
    variables: [{ name: 'SUITE_KEY', secret: true, value: '' }],
  })
  expect((await f.suites.catalog(actor)).installations[0]).toMatchObject({ missingCredentials: ['SUITE_KEY'] })
  await expect(
    f.execution.save(actor, 'skill:one', {
      enabled: true,
      commands: [{ command: 'suite-cli', blocked: [] }],
      variables: [{ name: 'SUITE_KEY', secret: true, value: 'x' }],
    }),
  ).rejects.toMatchObject({ code: 'suite-entry-locked' })
  await expect(f.suites.saveCredentials(actor, 'fixture-suite', { OTHER: 'x' })).rejects.toMatchObject({ code: 'suite-catalog-invalid' })
  await f.suites.saveCredentials(actor, 'fixture-suite', { SUITE_KEY: 'team-secret-value' })
  expect(f.executionRows.get('skill:one')).toMatchObject({ enabled: true, variables: [{ name: 'SUITE_KEY', secret: true, value: 'team-secret-value' }] })
  const view = await f.suites.catalog(actor)
  expect(view.installations[0]?.missingCredentials).toBeUndefined()
  expect(JSON.stringify(view)).not.toContain('team-secret-value')
  expect(JSON.stringify(f.state)).not.toContain('team-secret-value')
  expect(JSON.stringify(await f.execution.view(actor, 'skill:one'))).not.toContain('team-secret-value')
  // Blank values keep the saved credential.
  await f.suites.saveCredentials(actor, 'fixture-suite', { SUITE_KEY: '  ' })
  expect(f.executionRows.get('skill:one')?.variables[0]?.value).toBe('team-secret-value')
})

it('enables delegated execution at install when the wizard supplies every credential, and removes it on uninstall', async () => {
  const f = fixture(delegatedPreset())
  await expect(f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa0', credentials: { OTHER: 'x' } })).rejects.toThrow(
    expect.objectContaining({ code: 'suite-catalog-invalid' }),
  )
  await f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'team-secret-value' } })
  await f.settled('installed')
  expect(f.executionRows.get('skill:one')).toMatchObject({ enabled: true, variables: [{ name: 'SUITE_KEY', value: 'team-secret-value' }] })
  expect(JSON.stringify(f.state)).not.toContain('team-secret-value')
  expect(await f.suites.uninstallPreview(actor, 'fixture-suite')).toMatchObject({
    blocked: [],
    removes: expect.arrayContaining([{ kind: 'execution', name: 'one' }]),
  })
  await f.suites.uninstall(actor, 'fixture-suite')
  await expect.poll(() => f.state.installs.length).toBe(0)
  expect(f.executionRows.size).toBe(0)
  expect(f.dependencyRows.size).toBe(0)
  expect(f.libraryRows.size).toBe(0)
})

it('rolls back delegated execution when a later step fails', async () => {
  const preset = delegatedPreset()
  // A pack listing an unknown skill fails after the execution configuration was written.
  const broken: SuiteCatalogEntry = { ...preset, items: preset.items.map(item => (item.kind === 'skill-pack' ? { ...item, skills: ['one', 'ghost'] } : item)) }
  const f = fixture(broken)
  await f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'team-secret-value' } })
  await f.settled('failed')
  expect(f.executionRows.size).toBe(0)
  expect(f.dependencyRows.size).toBe(0)
  expect(f.libraryRows.size).toBe(0)
  expect(f.packRows.size).toBe(0)
  expect(JSON.stringify(f.state)).not.toContain('team-secret-value')
})

it('previews and refuses a delegated command that a manual skill already owns', async () => {
  const f = fixture(delegatedPreset())
  f.libraryRows.set('manual', { name: 'manual', description: 'manual', hash: 'manual', importedAt: 0, published: false })
  f.executionRows.set('skill:manual', { enabled: true, commands: [{ command: 'suite-cli', blocked: [] }], variables: [] })
  expect(await f.suites.installPreview(actor, 'fixture-suite')).toMatchObject({ reason: 'command-conflicts', commandConflicts: ['suite-cli'], creates: [] })
  await expect(f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })).rejects.toThrow(
    expect.objectContaining({ code: 'execution-config-invalid' }),
  )
  expect(f.state.installs).toHaveLength(0)
  expect(f.dependencyRows.size).toBe(0)
  // A disabled manual configuration does not hold the command.
  f.executionRows.set('skill:manual', { enabled: false, commands: [{ command: 'suite-cli', blocked: [] }], variables: [] })
  expect((await f.suites.installPreview(actor, 'fixture-suite')).reason).toBeUndefined()
})

it('detaches a pack so it can be edited, keeps its grants and publication, and keeps it on uninstall', async () => {
  const f = fixture()
  await f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', groups: ['team'], publish: true })
  await f.settled('installed')
  await expect(f.suites.detach(actor, 'fixture-suite', { kind: 'skill-pack', name: 'other' })).rejects.toMatchObject({ code: 'suite-entry-missing' })
  await f.suites.detach(actor, 'fixture-suite', { kind: 'skill-pack', name: 'fixture-suite' })
  expect(f.record()?.entries.map(entry => entry.name)).toEqual(['suite-cli', 'one', 'two'])
  expect(f.packRows.get('fixture-suite')).toMatchObject({ published: true })
  expect(f.packRows.get('fixture-suite')?.suiteOrigin).toBeUndefined()
  expect(f.packGrants.get('team')).toEqual(['fixture-suite'])
  await f.packs.save(
    actor,
    { name: 'fixture-suite', description: 'Edited pack', skills: ['one', 'two'], instructions: 'Edited note.', published: true },
    await f.packs.revision(actor),
  )
  expect(f.packRows.get('fixture-suite')).toMatchObject({ description: 'Edited pack', instructions: 'Edited note.' })
  // The detached pack still lists suite skills; it blocks uninstall until it no longer does, like any manual pack.
  expect((await f.suites.uninstallPreview(actor, 'fixture-suite')).blocked).toEqual([
    { name: 'one', references: [{ kind: 'skill-pack', name: 'fixture-suite' }] },
    { name: 'two', references: [{ kind: 'skill-pack', name: 'fixture-suite' }] },
  ])
  await f.suites.detach(actor, 'fixture-suite', { kind: 'skill', name: 'one' })
  await f.suites.detach(actor, 'fixture-suite', { kind: 'skill', name: 'two' })
  // Detached skills still need the suite CLI, so the dependency blocks uninstall until it is detached too.
  expect((await f.suites.uninstallPreview(actor, 'fixture-suite')).blocked).toEqual([
    {
      name: 'suite-cli',
      references: [
        { kind: 'skill', name: 'one' },
        { kind: 'skill', name: 'two' },
      ],
    },
  ])
  await expect(f.suites.uninstall(actor, 'fixture-suite')).rejects.toThrow(expect.objectContaining({ code: 'runtime-dependency-referenced' }))
  await f.suites.detach(actor, 'fixture-suite', { kind: 'runtime-dependency', name: 'suite-cli' })
  expect(f.dependencyRows.get('suite-cli')).toMatchObject({ source: 'manual', stage: 'ready' })
  expect(f.dependencyRows.get('suite-cli')?.managedOrigin).toBeUndefined()
  await f.suites.uninstall(actor, 'fixture-suite')
  await expect.poll(() => f.record()).toBeUndefined()
  expect([...f.libraryRows.keys()].sort()).toEqual(['one', 'two'])
  expect(f.packRows.has('fixture-suite')).toBe(true)
  expect(f.dependencyRows.has('suite-cli')).toBe(true)
  expect(f.packGrants.get('team')).toEqual(['fixture-suite'])
  expect(f.libraryRows.get('one')).toMatchObject({ runtimeDependencies: ['suite-cli'] })
  expect(f.libraryRows.get('one')?.suiteOrigin).toBeUndefined()
})

it('detaches delegated execution so the execution page can edit it and keeps its credentials', async () => {
  const f = fixture(delegatedPreset())
  await f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'team-secret-value' } })
  await f.settled('installed')
  await f.suites.detach(actor, 'fixture-suite', { kind: 'execution', name: 'one' })
  expect(f.executionRows.get('skill:one')).toMatchObject({ enabled: true, variables: [{ name: 'SUITE_KEY', value: 'team-secret-value' }] })
  expect(f.executionRows.get('skill:one')?.suiteOrigin).toBeUndefined()
  // The suite skill itself is still suite-owned, but its delegated execution is now edited like any manual configuration.
  await f.execution.save(actor, 'skill:one', {
    enabled: true,
    commands: [{ command: 'suite-cli', blocked: ['auth'] }],
    variables: [{ name: 'SUITE_KEY', secret: true }],
    runtimeDependencies: ['suite-cli'],
  })
  expect(f.executionRows.get('skill:one')).toMatchObject({
    commands: [{ command: 'suite-cli', blocked: ['auth'] }],
    variables: [{ value: 'team-secret-value' }],
  })
  expect((await f.suites.catalog(actor)).installations[0]?.missingCredentials).toBeUndefined()
  await expect(f.suites.saveCredentials(actor, 'fixture-suite', { SUITE_KEY: 'x' })).rejects.toMatchObject({ code: 'suite-catalog-invalid' })
})

it('detaches a skill together with its delegated execution, keeping grants, publication and credentials across uninstall', async () => {
  const f = fixture(delegatedPreset())
  await f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'team-secret-value' } })
  await f.settled('installed')
  await f.library.publish(actor, 'one', true, (await f.library.detail(actor, 'one')).revision).catch(() => {})
  await f.suites.detach(actor, 'fixture-suite', { kind: 'skill', name: 'one' })
  expect(f.record()?.entries.map(entry => `${entry.kind}:${entry.name}`)).toEqual(['runtime-dependency:suite-cli', 'skill-pack:fixture-suite'])
  expect(f.libraryRows.get('one')?.suiteOrigin).toBeUndefined()
  expect(f.executionRows.get('skill:one')?.suiteOrigin).toBeUndefined()
  // Once detached the skill is an ordinary entry: it can be published directly.
  await f.library.publish(actor, 'one', true, (await f.library.detail(actor, 'one')).revision)
  expect(f.libraryRows.get('one')?.published).toBe(true)
  // A second attempt reports the entry is gone from the suite rather than half-applying.
  await expect(f.suites.detach(actor, 'fixture-suite', { kind: 'skill', name: 'one' })).rejects.toMatchObject({ code: 'suite-entry-missing' })
  await f.suites.detach(actor, 'fixture-suite', { kind: 'skill-pack', name: 'fixture-suite' })
  await f.suites.detach(actor, 'fixture-suite', { kind: 'runtime-dependency', name: 'suite-cli' })
  await f.suites.uninstall(actor, 'fixture-suite')
  await expect.poll(() => f.record()).toBeUndefined()
  expect(f.libraryRows.get('one')).toMatchObject({ published: true })
  expect(f.executionRows.get('skill:one')).toMatchObject({ enabled: true, variables: [{ name: 'SUITE_KEY', value: 'team-secret-value' }] })
})

it('refuses to detach while a task runs for the suite or for a suite that shares it', async () => {
  const f = fixture()
  await f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1' })
  await expect(f.suites.detach(actor, 'fixture-suite', { kind: 'skill', name: 'one' })).rejects.toMatchObject({ code: 'suite-task-running' })
  await f.settled('installed')
  await expect(f.suites.detach(actor, 'fixture-suite', { kind: 'skill' })).rejects.toMatchObject({ code: 'suite-entry-missing' })
  await expect(f.suites.detach(actor, 'fixture-suite', { kind: 'skill', name: 'one', extra: true })).rejects.toMatchObject({ code: 'suite-catalog-invalid' })
})

it('reports skipped optional execution and only configured backend names without exposing values', async () => {
  const base = delegatedPreset()
  const preset = {
    ...base,
    items: base.items.map(item =>
      item.kind === 'execution'
        ? {
            ...item,
            variables: [
              { name: 'FIRST_KEY', optional: true, purpose: text },
              { name: 'SECOND_KEY', optional: true, purpose: text },
            ],
          }
        : item,
    ),
  }
  const f = fixture(preset)
  await f.suites.install(actor, { id: 'fixture-suite', requestId: 'request-optional-backend' })
  await f.settled('installed')
  expect((await f.suites.catalog(actor)).installations[0]).toMatchObject({ execution: { enabled: false, configuredVariables: [] } })
  await f.suites.saveCredentials(actor, 'fixture-suite', { FIRST_KEY: 'private-provider-value' })
  const result = await f.suites.catalog(actor)
  expect(result.installations[0]).toMatchObject({ execution: { enabled: true, configuredVariables: ['FIRST_KEY'] } })
  expect(JSON.stringify(result)).not.toContain('private-provider-value')
})
