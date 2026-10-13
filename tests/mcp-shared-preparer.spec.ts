import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { SharedMcpPreparer } from '../src/adapters/mcp-shared-preparer.js'
import { DevelopmentExecutionProcess } from '../src/adapters/execution-development-process.js'

it('retains private prepared credentials only while stored or leased by a running carrier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-shared-prepare-'))
  const runtime = { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } }
  const development = new DevelopmentExecutionProcess(); let readers: readonly string[] = []
  const preparer = new SharedMcpPreparer(runtime, { run: development.run.bind(development), recover: async () => {}, imageIdentity: async () => 'fixture', canDiscardArtifacts: true }, () => readers)
  try {
    await preparer.recover()
    const artifact = await preparer.prepare({ id: 'mcp:p-shared', version: 'first' }, { enabled: true, commands: [], variables: [{ name: 'API_KEY', value: 'fictional-key', secret: true }], prepare: 'printf "$API_KEY" > private.txt; printf "$API_KEY"' }, new AbortController().signal)
    expect(artifact.log).toBe('[redacted]')
    expect(preparer.directory(artifact.id)).not.toContain('/mcp/dependencies/')
    readers = [artifact.id]; await preparer.collect([])
    expect(await readFile(join(preparer.directory(artifact.id), 'private.txt'), 'utf8')).toBe('fictional-key')
    readers = []; await preparer.collect([])
    await expect(stat(preparer.directory(artifact.id))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { readers = []; await preparer.collect([]); await rm(root, { recursive: true, force: true }) }
})

it('releases a prepared artifact when development startup fails before a child exists', async () => {
  const { SharedMcpProcess } = await import('../src/adapters/mcp-shared-process.js')
  const { DEFAULT_EXECUTION_LIMITS } = await import('../src/domain/execution-control.js')
  const root = await mkdtemp(join(tmpdir(), 'mcp-startup-failure-'))
  const runtime = { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } }
  const carrier = new SharedMcpProcess(runtime, { isolated: false, containerConfig: undefined }, { get: () => DEFAULT_EXECUTION_LIMITS })
  const development = new DevelopmentExecutionProcess()
  const preparer = new SharedMcpPreparer(runtime, { run: development.run.bind(development), recover: async () => {}, imageIdentity: async () => 'fixture', canDiscardArtifacts: true }, carrier.retainedArtifacts.bind(carrier))
  const previous = process.env.TMPDIR
  try {
    await preparer.recover()
    const artifact = await preparer.prepare({ id: 'mcp:p-shared', version: 'first' }, { enabled: true, commands: [], variables: [] }, new AbortController().signal)
    process.env.TMPDIR = join(root, 'absent-parent')
    await expect(carrier.start({ name: 'p-shared', generation: 1, url: '', description: '', prepared: { directory: preparer.directory(artifact.id) }, run: { location: 'shared', command: 'node', args: [], env: [], prepareCommand: '' } }, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'ENOENT' })
    await preparer.collect([])
    await expect(stat(preparer.directory(artifact.id))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; await rm(root, { recursive: true, force: true }) }
})
