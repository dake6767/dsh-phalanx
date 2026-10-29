import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { expect, it } from 'vitest'
import { memberMcpEntries, memberMcpLaunchConfiguration } from '../src/dsh/member-mcp.js'
import { memberMcpFilter } from '../src/dsh/mcp-stdio-filter.js'
import { serveMemberMcpInput } from './support/mcp-member-input.js'

it('launches a projected member service through the real SDK with explicit gateway references and masked output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-member-transport-')),
    secret = 'fictional-member-transport-key'
  const service = {
    name: 'p-test',
    description: '',
    url: '',
    generation: 1,
    run: { location: 'member' as const, command: process.execPath, args: [join(root, 'server.mjs')], env: [{ name: 'PRIVATE_KEY', value: secret }] },
    prepared: { directory: root, dependencies: [] },
  }
  await writeFile(join(root, 'filter.mjs'), memberMcpFilter)
  await writeFile(
    join(root, 'server.mjs'),
    `import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})){const row=JSON.parse(line);if(row.id===undefined)continue;
const result=row.method==='initialize'?{protocolVersion:row.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:row.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'MEMBER_CLIENT_READY '+process.env.PRIVATE_KEY}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:row.id,result})+'\\n');}`,
  )
  const gateway = await serveMemberMcpInput(memberMcpLaunchConfiguration(service))
  const client = new Client({ name: 'fixture', version: '1' }, { capabilities: {} })
  try {
    const serialized = memberMcpEntries([service], 'fixture-module', root)
    for (const value of [secret, gateway.access.token]) expect(serialized).not.toContain(value)
    const entry = JSON.parse(serialized)[0] as { config: { command: string; args: string[]; env?: Record<string, { __jsExpr: string }> } }
    // Resolve only the platform-generated expressions, as the official loader does.
    const env = Object.fromEntries(
      Object.entries(entry.config.env ?? {}).map(([name, value]) => [
        name,
        new Function('process', 'return ' + value.__jsExpr)({ env: gateway.environment }) as string,
      ]),
    )
    // The SDK constructs its own child environment; inherited DSH_* values are unavailable.
    await client.connect(new StdioClientTransport({ command: entry.config.command, args: entry.config.args, env, stderr: 'ignore' }))
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['echo'])
    expect(await client.callTool({ name: 'echo', arguments: {} })).toMatchObject({ content: [{ text: 'MEMBER_CLIENT_READY [redacted]' }] })
  } finally {
    await client.close()
    await gateway.close()
    await rm(root, { recursive: true, force: true })
  }
})
