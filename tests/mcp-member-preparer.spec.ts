import { mkdtemp, readFile, rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { MemberMcpPreparer } from '../src/adapters/mcp-member-preparer.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { DevelopmentExecutionProcess } from '../src/adapters/execution-development-process.js'

it('freezes one content-addressed dependency tree and reuses it without copying per member', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-prepare-'))
  const config = { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } }
  const development = new DevelopmentExecutionProcess()
  const process = { run: development.run.bind(development), recover: async () => {}, imageIdentity: async () => 'development-fixture', canDiscardArtifacts: true }
  const preparer = new MemberMcpPreparer(config, process)
  const owner = { id: 'mcp:p-test', version: 'a'.repeat(64) }, configuration = { enabled: true, commands: [], variables: [], prepare: 'printf pinned > dependency.txt' }
  try {
    await preparer.recover()
    const first = await preparer.prepare(owner, configuration, new AbortController().signal)
    const second = await preparer.prepare(owner, configuration, new AbortController().signal)
    expect(first.id).toBe(first.hash); expect(second.id).toBe(first.id)
    expect(await readFile(join(preparer.directory(first.id), 'dependency.txt'), 'utf8')).toBe('pinned')
    expect((await stat(join(preparer.directory(first.id), 'dependency.txt'))).mode & 0o222).toBe(0)
    await preparer.collect()
    expect(await readdir(join(root, 'mcp', 'dependencies', '.trees'))).toHaveLength(1)
  } finally { await new FileExecutionArtifacts(join(root, 'mcp', 'dependencies', '.trees')).collect([]); await rm(root, { recursive: true, force: true }) }
})
