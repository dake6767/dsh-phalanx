// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { ContainerExecutionProcess } from '../src/adapters/execution-container-process.js'
import { SharedMcpProcess } from '../src/adapters/mcp-shared-process.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { RuntimeDependencyPreparer } from '../src/adapters/runtime-dependency-preparer.js'
import { DEFAULT_EXECUTION_LIMITS } from '../src/domain/execution-control.js'
import { ExecutionControl } from '../src/use-cases/execution-control.js'
import { McpSharedRuntime } from '../src/use-cases/mcp-shared-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'

it('protects active rootless shared calls, but reaps them on call timeout and idle expiry before releasing dependencies', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'mcp-shared-limits-'))
  const config = runtimeSection(root, 'http://127.0.0.1:1', runtimeSettings)
  const limits = {
    get: async () => ({ ...DEFAULT_EXECUTION_LIMITS, memberConcurrency: 1, platformConcurrency: 1, memoryMiB: 128, cpus: 0.5, pids: 32 }),
    async save() {},
  }
  const execution = new ContainerExecutionProcess(config, limits),
    process = new SharedMcpProcess(config, execution, limits)
  const preparer = new RuntimeDependencyPreparer(execution, new FileExecutionArtifacts(join(root, 'runtime-dependencies/.trees')))
  const deadlines: AbortController[] = []
  let now = 0,
    sweep = () => {}
  const control = new ExecutionControl(limits, {
    start: () => {
      const controller = new AbortController()
      deadlines.push(controller)
      return { signal: controller.signal, dispose() {} }
    },
  })
  let running: McpSharedRuntime | undefined
  try {
    await execution.recover()
    await process.recover()
    await preparer.recover()
    const artifact = await preparer.prepare(
      { name: 'shared-fixture', type: 'resource', prepareCommand: 'printf fixture > retained', pathDirectories: [] },
      async () => {},
      new AbortController().signal,
    )
    const service = {
      name: 'p-limits',
      description: '',
      url: '',
      generation: 1,
      prepared: { directory: artifact.mountedPath, dependencies: [artifact] },
      run: {
        location: 'shared' as const,
        command: 'node',
        args: [
          '-e',
          `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'fixture',version:'1'}}})+'\\n')})`,
        ],
        env: [],
        prepareCommand: '',
      },
    }
    running = new McpSharedRuntime(
      process,
      control,
      { now: () => now },
      {
        start: callback => {
          sweep = callback
          return () => {}
        },
      },
      async () => service,
      60,
    )
    running.start()
    const first = await running.connect('alice', service, false)
    expect((await fetch(first.baseUrl)).status).toBe(401)
    const request = { username: 'bob', owner: 'skill:fixture', command: 'fixture', argv: [], cwd: '', stdin: new Uint8Array() }
    await expect(control.run(request, new AbortController().signal, async () => 0)).rejects.toMatchObject({ code: 'concurrency' })
    const ids = async () =>
      (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.mcp-shared=${execution.ownership}`, '--format', '{{.ID}}']))
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
    const containers = await ids()
    expect(containers).toHaveLength(1)
    const inspected = JSON.parse(await execFileText('podman', ['inspect', containers[0]!]))[0]
    expect(inspected.HostConfig.Memory).toBe(128 * 1024 * 1024)
    expect(inspected.HostConfig.PidsLimit).toBe(32)
    const headers: Record<string, string> = { authorization: first.headers[0]!.value, 'content-type': 'application/json' }
    const init = await fetch(first.baseUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) })
    headers['mcp-session-id'] = init.headers.get('mcp-session-id')!
    await init.text()
    const call = await fetch(first.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'silent' } }),
    })
    const result = call.text().catch(() => 'closed')
    await expect.poll(() => deadlines.length).toBe(3)
    now = 121_000
    sweep()
    await running.reconcile()
    expect(await ids()).toEqual(containers)
    expect(process.retainedArtifacts()).toHaveLength(1)
    deadlines.at(-1)!.abort()
    await result
    await expect.poll(ids, { timeout: 30000 }).toHaveLength(0)
    await expect.poll(() => process.retainedArtifacts().length, { timeout: 30000 }).toBe(0)
    expect(await control.run(request, new AbortController().signal, async () => 0)).toBe(0)
    const second = await running.connect('alice', service, false)
    expect((await fetch(second.baseUrl)).status).toBe(401)
    now += 60_001
    sweep()
    await expect.poll(ids, { timeout: 30000 }).toHaveLength(0)
    await expect.poll(() => process.retainedArtifacts().length, { timeout: 30000 }).toBe(0)
    await expect(fetch(second.baseUrl)).rejects.toThrow()
    await preparer.collect(process.retainedArtifacts())
    expect(await control.run(request, new AbortController().signal, async () => 0)).toBe(0)
  } finally {
    await running?.stop()
    await execution.stop()
    await preparer.collect(process.retainedArtifacts())
    await removeCommunityFixture(root)
  }
})

it('retains credential-bearing dependencies after failed container removal until owned recovery succeeds', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'mcp-shared-removal-'))
  const base = runtimeSection(root, 'http://127.0.0.1:1', runtimeSettings)
  if (!('container' in base)) throw Error('Rootless container acceptance required')
  const wrapper = join(root, 'podman'),
    failure = join(root, 'fail-removal')
  await writeFile(
    wrapper,
    `#!/bin/sh
if [ "$1" = rm ] && [ -f "${failure}" ]; then exit 91; fi
exec podman "$@"
`,
  )
  await chmod(wrapper, 0o700)
  const config = { ...base, container: { ...base.container, runtime: wrapper } }
  const limits = { get: async () => DEFAULT_EXECUTION_LIMITS }
  const execution = new ContainerExecutionProcess(config, limits),
    process = new SharedMcpProcess(config, execution, limits)
  const preparer = new RuntimeDependencyPreparer(execution, new FileExecutionArtifacts(join(root, 'runtime-dependencies/.trees'))),
    abort = new AbortController()
  try {
    await execution.recover()
    await process.recover()
    await preparer.recover()
    const artifact = await preparer.prepare(
      { name: 'shared-fixture', type: 'resource', prepareCommand: 'printf fixture > retained', pathDirectories: [] },
      async () => {},
      new AbortController().signal,
    )
    const service = {
      name: 'p-removal',
      description: '',
      url: '',
      generation: 1,
      prepared: { directory: artifact.mountedPath, dependencies: [artifact] },
      run: { location: 'shared' as const, command: 'node', args: ['-e', 'process.stdin.resume()'], env: [], prepareCommand: '' },
    }
    const handle = await process.start(service, () => {}, abort.signal)
    await writeFile(failure, 'fail once until explicit recovery')
    abort.abort()
    await expect(handle.closed).rejects.toThrow()
    await preparer.collect(process.retainedArtifacts())
    expect((await stat(artifact.directory)).isDirectory()).toBe(true)
    await rm(failure)
    await process.recover()
    await preparer.collect(process.retainedArtifacts())
    await expect(stat(artifact.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    abort.abort()
    await rm(failure, { force: true })
    await process.recover()
    await execution.stop()
    await preparer.collect(process.retainedArtifacts())
    await removeCommunityFixture(root)
  }
})
