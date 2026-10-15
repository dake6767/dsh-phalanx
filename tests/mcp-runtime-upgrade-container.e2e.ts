// Validation: T4 integration; real credentials: none; exact historical amd64 artifacts required. Not part of the approved T2 batch.
import { mkdtemp, readFile, rm, writeFile, readdir, chmod, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MemberMcpPreparer } from './fixtures/legacy-mcp/member-preparer.js'
import { SharedMcpPreparer } from './fixtures/legacy-mcp/shared-preparer.js'
import { ContainerExecutionProcess } from '../src/adapters/execution-container-process.js'
import { FileExecutionPreparations } from '../src/adapters/execution-preparation-store.js'
import { McpRuntimePreparation } from './fixtures/legacy-mcp/runtime-preparation.js'
import { DEFAULT_EXECUTION_LIMITS } from '../src/domain/execution-control.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import type { McpService } from '../src/domain/mcp-service.js'

const previousImage = process.env.DSH_PHALANX_019_CONTAINER_IMAGE
for (const location of ['member', 'shared'] as const) it.skipIf(!previousImage || !runtimeSettings.containerImage)(`reprepares persisted ${location} MCP artifacts across actual DSH image revisions`, async () => {
  assertPinnedDshRevision(runtimeSettings)
  const oldRevision = (await execFileText('podman', ['image', 'inspect', previousImage!, '--format', '{{index .Config.Labels "dsh.revision"}}'])).trim()
  const newRevision = (await execFileText('podman', ['image', 'inspect', runtimeSettings.containerImage!, '--format', '{{index .Config.Labels "dsh.revision"}}'])).trim()
  expect(oldRevision).toBe('5badb15009ae1756c3afe0ae0cef1faafc290ccc'); expect(newRevision).not.toBe(oldRevision)
  const root = await mkdtemp(join(tmpdir(), 'mcp-revision-')), base = runtimeSection(root, 'https://example.test', runtimeSettings)
  if (!('container' in base)) throw Error('Container acceptance required')
  const service: McpService = { name: 'p-revision', description: '', url: '', generation: 1, run: { location, command: 'node', args: [], env: [], prepareCommand: 'node -e \'require("fs").writeFileSync("prepared.json",JSON.stringify({nonce:require("crypto").randomUUID(),node:process.version}))\'' } }
  const state = { services: [service], grants: { ordinary: ['p-revision'] }, selections: { member: ['p-revision'] } }
  const create = (image: string) => {
    const config = { ...base, container: { ...base.container!, image } }, execution = new ContainerExecutionProcess(config, { get: () => DEFAULT_EXECUTION_LIMITS })
    const preparer = location === 'member' ? new MemberMcpPreparer(config, execution) : new SharedMcpPreparer(config, execution)
    const records = new FileExecutionPreparations(join(root, 'preparations.json'))
    const runtime = new McpRuntimePreparation({ read: () => state }, records, preparer, { now: () => Date.now() }, async () => {}, location)
    return { runtime, execution, records }
  }
  let current = create(previousImage!), passed = false
  let oldIdentity = '', newIdentity = ''
  try {
    await current.runtime.recover(); current.runtime.start()
    await expect.poll(() => current.runtime.ready(service), { timeout: 30000 }).toBeDefined()
    const before = current.records.get('mcp:p-revision')!; oldIdentity = before.identity
    expect(before.stage).toBe('ready'); expect(Boolean(before.artifact)).toBe(true)
    await current.runtime.stop(); await current.execution.stop()
    current = create(runtimeSettings.containerImage!)
    await current.runtime.recover(); expect(current.runtime.ready(service)).toBeUndefined()
    current.runtime.start()
    await expect.poll(() => current.runtime.ready(service), { timeout: 30000 }).toBeDefined()
    const after = current.records.get('mcp:p-revision')!; newIdentity = after.identity
    expect(newIdentity).not.toBe(oldIdentity); expect(after.artifact!.id).not.toBe(before.artifact!.id)
    const host = location === 'shared' ? join(root, 'mcp/shared-dependencies', after.artifact!.id) : join(root, 'mcp/dependencies', after.artifact!.id)
    expect(JSON.parse(await readFile(join(host, 'prepared.json'), 'utf8'))).toMatchObject({ nonce: expect.any(String), node: expect.any(String) })
    expect(state.grants.ordinary).toEqual(['p-revision']); expect(state.selections.member).toEqual(['p-revision'])
    passed = true
  } finally {
    await current.runtime.stop(); await current.execution.stop()
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    await writable(root); await rm(root, { recursive: true, force: true })
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await writeFile(join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, `mcp-${location}-revision-result.json`), JSON.stringify({ passed, oldRevision, newRevision, oldIdentity, newIdentity }) + '\n')
  }
}, 120000)
