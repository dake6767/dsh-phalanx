// Validation: T2; real credentials: none; actual immutable runtime dependencies and fresh Linux execution containers.
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileCommunityUserSpaces } from '../src/adapters/community-user-spaces.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { ContainerExecutionProcess } from '../src/adapters/execution-container-process.js'
import { ContainerExecutionRunner } from '../src/adapters/execution-runner.js'
import { RuntimeDependencyPreparer } from '../src/adapters/runtime-dependency-preparer.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { createRuntimeStorage } from '../src/composition/runtime-storage.js'
import { effectiveUserDataRoot } from '../src/domain/storage-layout.js'
import { ExecutionDependencies } from '../src/use-cases/execution-dependencies.js'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import { seedExecutionOwners } from './fixtures/execution-owners.js'
import { cleanupOwned, removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { skillZip } from './fixtures/skills/archive.js'
import { openTestDatabase } from './support/community-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'

it.skipIf(!runtimeSettings.containerImage)(
  'prepares controlled MPS requirements once and uses immutable dependencies in fresh execution containers',
  async () => {
    assertPinnedDshRevision(runtimeSettings)
    const root = await mkdtemp(join(tmpdir(), 'execution-preparation-')),
      runtime = runtimeSection(root, 'https://example.test', runtimeSettings)
    const database = await openTestDatabase(root),
      storage = createRuntimeStorage(database)
    const artifacts = new FileExecutionArtifacts(join(root, 'runtime-dependencies/.trees')),
      sources = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
    const process = new ContainerExecutionProcess(runtime),
      preparer = new RuntimeDependencyPreparer(process, artifacts)
    const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
    const dependencies = new RuntimeDependencies(
      { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
      storage.store,
      preparer,
      { now: () => Date.now() },
      storage.references,
    )
    let exists = true,
      version = ''
    const lifecycle = new ExecutionDependencies(
      { identities: () => (exists ? ['skill:mps-fixture'] : []), get: id => (exists ? { id, version } : undefined), owns: async () => exists },
      storage.execution,
      dependencies,
    )
    const runner = new ContainerExecutionRunner(
      runtime,
      new FileCommunityUserSpaces(runtime, { getSpace: async () => ({ spaceId: 'fixture-space', storageKey: 'member' }) }, { assertAvailable: async () => {} }),
      sources,
      process,
    )
    try {
      await seedExecutionOwners(database, ['skill:mps-fixture'])
      await storage.initialize()
      const wheel = skillZip([
        { path: 'fixture_dependency/__init__.py', content: 'VALUE = "prepared-requirement"\n' },
        { path: 'fixture_dependency-1.0.0.dist-info/METADATA', content: 'Metadata-Version: 2.1\nName: fixture-dependency\nVersion: 1.0.0\n' },
        {
          path: 'fixture_dependency-1.0.0.dist-info/WHEEL',
          content: 'Wheel-Version: 1.0\nGenerator: controlled-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
        },
        { path: 'fixture_dependency-1.0.0.dist-info/RECORD', content: '' },
      ])
      const zip = skillZip([
        { path: 'SKILL.md', content: '---\nname: mps-fixture\ndescription: Controlled requirements fixture\n---\nUse scripts/check.py.' },
        {
          path: 'scripts/hold.py',
          content:
            'import pathlib,time,fixture_dependency\npathlib.Path("started").write_text("ready")\nwhile not pathlib.Path("release").exists(): time.sleep(0.05)\nprint(fixture_dependency.VALUE)\n',
        },

        {
          path: 'scripts/check.py',
          content:
            'import fixture_dependency, pathlib\nprint(fixture_dependency.VALUE)\ntry:\n pathlib.Path(fixture_dependency.__file__).write_text("changed")\n print("WRITABLE")\nexcept (PermissionError, OSError):\n print("READONLY")\n',
        },
      ])
      const skill = await sources.accept(
        (async function* () {
          yield zip
        })(),
        new AbortController().signal,
      )
      version = skill.hash
      const input = {
        name: 'mps-fixture',
        prepareCommand: `node -e 'require("fs").writeFileSync("fixture_dependency-1.0.0-py3-none-any.whl",Buffer.from("${wheel.toString('base64')}","base64"))' && python3 -m venv --copies venv && venv/bin/pip install --no-index --no-deps fixture_dependency-1.0.0-py3-none-any.whl`,
        pathDirectories: ['venv/bin'],
        checkCommand: 'python3 -c "import fixture_dependency; print(fixture_dependency.VALUE)"',
      }
      await dependencies.recover()
      await dependencies.create(actor, input)
      await dependencies.start()
      await dependencies.prepare(actor, input.name)
      const prepared = dependencies.ready([input.name])[0]!
      expect(prepared.log).toContain('Successfully installed fixture-dependency-1.0.0')
      await storage.execution.save('skill:mps-fixture', {
        enabled: true,
        commands: [{ command: 'scripts/check.py', blocked: [] }],
        variables: [],
        runtimeDependencies: [input.name],
      })
      const execute = (command: string, outputs: string[]) =>
        lifecycle.withPrepared('skill:mps-fixture', material =>
          runner.run(
            {
              username: 'member',
              owner: 'skill:mps-fixture',
              version: material.version,
              dependencies: material.dependencies ?? [],
              command,
              argv: [],
              cwd: '/dsh-phalanx/workspace',
              stdin: new Uint8Array(),
              environment: {},
            },
            async event => {
              outputs.push(Buffer.from(event.data).toString())
            },
            new AbortController().signal,
          ),
        )
      const outputs: string[] = []
      for (let call = 0; call < 2; call++) expect(await execute('scripts/check.py', outputs)).toBe(0)
      expect(outputs.join('')).toBe('prepared-requirement\nREADONLY\nprepared-requirement\nREADONLY\n')
      await dependencies.update(actor, input.name, { ...input, prepareCommand: 'printf "fixture diagnostic"; exit 9' })
      await expect.poll(async () => (await dependencies.view(actor, input.name)).stage).toBe('failed')
      expect(await dependencies.view(actor, input.name)).toMatchObject({ log: expect.stringContaining('fixture diagnostic'), current: { id: prepared.id } })
      const heldOutput: string[] = []
      const running = execute('scripts/hold.py', heldOutput)
      void running.catch(() => {})
      await expect
        .poll(
          async () => {
            try {
              return await readFile(join(effectiveUserDataRoot(runtime), 'member/workspace/started'), 'utf8')
            } catch {
              return ''
            }
          },
          { timeout: 30000 },
        )
        .toBe('ready')
      exists = false
      await lifecycle.changed()
      expect(await storage.execution.list()).toEqual([])
      await dependencies.remove(actor, input.name)
      expect(await storage.store.list()).toEqual([])
      expect(await readdir(join(root, 'runtime-dependencies/.trees'))).toContain(prepared.id)
      await writeFile(join(effectiveUserDataRoot(runtime), 'member/workspace/release'), 'release')
      expect(await running).toBe(0)
      expect(heldOutput.join('')).toBe('prepared-requirement\n')
      expect(await readdir(join(root, 'runtime-dependencies/.trees'))).toEqual([])
      await process.recover()
    } finally {
      await cleanupOwned(
        () => runner.stop(),
        () => lifecycle.stop(),
        () => dependencies.stop(),
        () => storage.close(),
        () => database.close(),
        () => artifacts.collect([]),
        () => sources.collect([]),
        () => removeCommunityFixture(root),
      )
    }
  },
  180000,
)
