import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ContainerExecutionProcess } from '../src/adapters/execution-container-process.js'
import { ContainerExecutionPreparer } from '../src/adapters/execution-preparer.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { ContainerExecutionRunner } from '../src/adapters/execution-runner.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileCommunityUserSpaces } from '../src/adapters/community-user-spaces.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { skillZip } from './fixtures/skills/archive.js'
import type { ExecutionConfiguration } from '../src/domain/platform-execution.js'

it.skipIf(!runtimeSettings.containerImage)('prepares controlled MPS requirements once and uses immutable dependencies in fresh execution containers', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'execution-preparation-')), runtime = runtimeSection(root, 'https://example.test', runtimeSettings)
  const artifacts = new FileExecutionArtifacts(join(root, 'execution-artifacts')), sources = new FileSkillArtifacts(join(root, 'skills'), [])
  const process = new ContainerExecutionProcess(runtime), preparer = new ContainerExecutionPreparer(runtime, process, sources, artifacts)
  try {
    const wheel = skillZip([
      { path: 'fixture_dependency/__init__.py', content: 'VALUE = "prepared-requirement"\n' },
      { path: 'fixture_dependency-1.0.0.dist-info/METADATA', content: 'Metadata-Version: 2.1\nName: fixture-dependency\nVersion: 1.0.0\n' },
      { path: 'fixture_dependency-1.0.0.dist-info/WHEEL', content: 'Wheel-Version: 1.0\nGenerator: controlled-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n' },
      { path: 'fixture_dependency-1.0.0.dist-info/RECORD', content: '' },
    ])
    const zip = skillZip([{ path: 'SKILL.md', content: '---\nname: mps-fixture\ndescription: Controlled requirements fixture\n---\nUse scripts/check.py.' },
      { path: 'requirements.txt', content: './fixture_dependency-1.0.0-py3-none-any.whl\n' },
      { path: 'fixture_dependency-1.0.0-py3-none-any.whl', content: wheel },
      { path: 'scripts/check.py', content: 'import fixture_dependency, pathlib\nprint(fixture_dependency.VALUE)\ntry:\n pathlib.Path(fixture_dependency.__file__).write_text("changed")\n print("WRITABLE")\nexcept (PermissionError, OSError):\n print("READONLY")\n' }])
    const skill = await sources.accept((async function* () { yield zip })(), new AbortController().signal)
    const owner = { id: 'skill:mps-fixture', version: skill.hash }
    const configuration: ExecutionConfiguration = { enabled: true, commands: [{ command: 'scripts/check.py', blocked: [] }], variables: [{ name: 'FIXTURE_SECRET', value: 'fictional-preparation-key', secret: true }], prepare: 'python3 -m venv .venv && .venv/bin/pip install --no-index --no-deps -r requirements.txt && printf "%s" "$FIXTURE_SECRET"' }
    await preparer.recover()
    const identity = preparer.identity(owner, configuration)
    expect(preparer.identity(owner, { ...configuration, prepare: 'changed' })).not.toBe(identity)
    const prepared = await preparer.prepare(owner, configuration, new AbortController().signal)
    expect(prepared.log).toContain('Successfully installed fixture-dependency-1.0.0')
    expect(prepared.log).not.toContain('fictional-preparation-key'); expect(prepared.log).toContain('[redacted]')
    const runner = new ContainerExecutionRunner(runtime, new FileCommunityUserSpaces(runtime, { getSpace: () => ({ spaceId: 'fixture-space', storageKey: 'member' }) }), sources, process, artifacts)
    const outputs: string[] = []
    for (let call = 0; call < 2; call++) {
      const code = await runner.run({ username: 'member', owner: owner.id, version: skill.hash, artifact: prepared.id, command: 'scripts/check.py', argv: [], cwd: '/dsh-phalanx/workspace', stdin: new Uint8Array(), environment: {} },
        async event => { outputs.push(Buffer.from(event.data).toString()) }, new AbortController().signal)
      expect(code).toBe(0)
    }
    expect(outputs.join('')).toBe('prepared-requirement\nREADONLY\nprepared-requirement\nREADONLY\n')
    await expect(preparer.prepare(owner, { ...configuration, prepare: 'printf "fixture diagnostic"; exit 9' }, new AbortController().signal)).rejects.toMatchObject({ log: expect.stringContaining('fixture diagnostic') })
    // Recovery may only remove containers owned by this platform data root.
    await process.recover()
  } finally { await process.stop(); await artifacts.collect([]); await sources.collect([]); await rm(root, { recursive: true, force: true }) }
}, 180000)
