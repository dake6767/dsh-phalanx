import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveMemberMcpInput } from './support/mcp-member-input.js'
import { MemberMcpProbe } from '../src/adapters/mcp-member-probe.js'
import { memberMcpFilter } from '../src/dsh/mcp-stdio-filter.js'

it('finishes diagnostics only after reclaiming a server that ignores EOF and SIGTERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-diagnostic-')),
    dependencies = join(root, 'dependencies')
  await mkdir(dependencies)
  await mkdir(join(root, 'mcp/members/fixture'), { recursive: true })
  await writeFile(join(root, 'mcp/members/fixture/filter.mjs'), memberMcpFilter)
  await writeFile(
    join(dependencies, 'server.mjs'),
    `import {createInterface} from 'node:readline';import {writeFileSync} from 'node:fs';
writeFileSync('server.pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
createInterface({input:process.stdin}).on('line',line=>{const row=JSON.parse(line);if(row.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:row.id,result:row.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:{tools:[{name:'fixture',description:'',inputSchema:{type:'object'}}]}})+'\\n')});`,
  )
  const config = {
    command: '/unavailable',
    args: [],
    dataRoot: root,
    defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
  }
  const gateway = await serveMemberMcpInput(
    { directory: dependencies, command: process.execPath, args: [join(dependencies, 'server.mjs')], env: [], timeoutMs: 30000 },
    true,
  )
  const probe = new MemberMcpProbe(
    config,
    async () => ({
      name: 'p-test',
      description: '',
      url: '',
      generation: 1,
      prepared: { directory: dependencies },
      run: { location: 'member', command: process.execPath, args: [join(dependencies, 'server.mjs')], env: [], prepareCommand: '' },
    }),
    async () => ({ userId: 'admin', origin: '', launchUrl: '', processId: 0 }),
    { async assertAvailable() {}, prepare: async () => ({ home: root, workspace: root, spaceId: 'fixture' }) },
    async () => gateway.access,
  )
  try {
    expect(await probe.probe('admin', 'fixture', 'p-test')).toEqual([{ name: 'fixture', description: '', inputSchema: { type: 'object' } }])
    const pid = Number(await readFile(join(root, 'server.pid'), 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    // Preserve a failed cleanup assertion while ensuring the fixture cannot outlive this test.
    const pid = Number(await readFile(join(root, 'server.pid'), 'utf8').catch(() => '0'))
    if (pid) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* already reaped */
      }
    }
    await probe.stop()
    await gateway.close()
    await rm(root, { recursive: true, force: true })
  }
}, 12000)
