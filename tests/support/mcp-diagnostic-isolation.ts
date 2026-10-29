import { ContainerExecutionProcess } from '../../src/adapters/execution-container-process.js'
import { runtimeSection, type RealDshRuntimeTestSettings } from './real-dsh-runtime.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import { SharedMcpProcess } from '../../src/adapters/mcp-shared-process.js'
import { ExecutionDeadlines } from '../../src/adapters/execution-control-store.js'
import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/execution-control.js'
import { McpSharedRuntime } from '../../src/use-cases/mcp-shared-runtime.js'
import { ExecutionControl } from '../../src/use-cases/execution-control.js'
import type { CommunityRuntimeConfig } from '../../src/domain/community-config.js'
import type { PluginUpstream } from '../../src/domain/plugin-upstream.js'

export async function verifyMcpDiagnosticIsolation(settings?: RealDshRuntimeTestSettings): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-diagnostic-isolation-'))
  const limits = { get: async () => DEFAULT_EXECUTION_LIMITS, async save() {} }
  const control = new ExecutionControl(limits, new ExecutionDeadlines())
  const config = settings ? runtimeSection(directory, 'https://example.test', settings) : ({ dataRoot: directory } as CommunityRuntimeConfig)
  const execution = settings ? new ContainerExecutionProcess(config, limits) : undefined
  await execution?.recover()
  const process = new SharedMcpProcess(config, execution ?? { isolated: false, containerConfig: undefined }, limits)
  const service = {
    name: 'p-search',
    description: '',
    url: '',
    generation: 1,
    prepared: { directory },
    run: { location: 'shared' as const, command: 'node', args: ['server.mjs'], env: [] },
  }
  const runtime = new McpSharedRuntime(process, control, { now: () => 0 }, { start: () => () => {} }, async () => service)
  await writeFile(
    join(directory, 'server.mjs'),
    `import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;
const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[]}:{content:[{type:'text',text:'member-still-connected'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}`,
  )
  const initialize = async (target: PluginUpstream) => {
    const headers: Record<string, string> = { authorization: target.headers[0]!.value, 'content-type': 'application/json' }
    const send = (body: object) => fetch(target.baseUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...body }) })
    const response = await send({ id: 1, method: 'initialize' })
    expect(response.status).toBe(200)
    headers['mcp-session-id'] = response.headers.get('mcp-session-id')!
    await response.text()
    expect((await send({ method: 'notifications/initialized' })).status).toBe(202)
    return { headers, send }
  }
  try {
    const member = await initialize(await runtime.connect('admin', service, false))
    const diagnosticTarget = await runtime.connect('admin', service, true)
    const diagnostic = await initialize(diagnosticTarget)
    expect(await (await diagnostic.send({ id: 2, method: 'tools/list' })).text()).toContain('"tools":[]')
    expect((await fetch(diagnosticTarget.baseUrl, { method: 'DELETE', headers: diagnostic.headers })).status).toBe(200)
    const response = await member.send({ id: 3, method: 'tools/call', params: { name: 'search' } })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('member-still-connected')
  } finally {
    await runtime.stop()
    await execution?.stop()
    await rm(directory, { recursive: true, force: true })
  }
}
