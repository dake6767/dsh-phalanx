import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'
import { sharedMcpBridge } from '../src/adapters/mcp-shared-bridge.js'

it('bridges private stdio to authenticated HTTP with sessions, notifications and server requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-bridge-'))
  await writeFile(join(directory, 'server.mjs'), `import {createInterface} from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
for await (const line of createInterface({input:process.stdin})) { const m=JSON.parse(line);
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}});
else if(m.method==='tools/call') { send({jsonrpc:'2.0',method:'notifications/message',params:{data:'notice'}}); send({jsonrpc:'2.0',id:'server-request',method:'roots/list'}); send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:process.env.FIXTURE_KEY}]}}); }
}`)
  const child = spawn(process.execPath, ['--input-type=module', '-e', sharedMcpBridge], { stdio: ['pipe', 'pipe', 'pipe'] })
  const exit = once(child, 'exit'); child.stderr.resume()
  child.stdin.end(JSON.stringify({ token: 'private-bridge-token', directory, command: process.execPath, args: ['server.mjs'], environment: { FIXTURE_KEY: 'fictional-{dependencies}' }, port: 0, host: '127.0.0.1' }))
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  try {
    const ready = JSON.parse((await lines.next()).value!); const url = `http://127.0.0.1:${ready.port}/mcp`
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401)
    const headers: Record<string, string> = { authorization: 'Bearer private-bridge-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    const send = (value: unknown) => fetch(url, { method: 'POST', headers, body: JSON.stringify(value) })
    const initialized = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(initialized.status).toBe(200); headers['mcp-session-id'] = initialized.headers.get('mcp-session-id')!
    expect(await initialized.text()).toContain('"id":1')
    expect((await send({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
    const call = await send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search' } })
    const result = await call.text()
    expect(result).toContain('notifications/message'); expect(result).toContain('roots/list'); expect(result).toContain('fictional-{dependencies}'); expect(result).toContain('"id":2')
    const bad = await fetch(url, { method: 'GET', headers: { ...headers, 'mcp-session-id': 'another-member' } }); expect(bad.status).toBe(404)
    expect((await fetch(url, { method: 'DELETE', headers })).status).toBe(200)
    await exit
  } finally { child.kill('SIGKILL'); await exit; await rm(directory, { recursive: true, force: true }) }
})

it('runs the explicit development fallback with configured credentials and reaps it on cancellation', async () => {
  const { SharedMcpProcess } = await import('../src/adapters/mcp-shared-process.js')
  const { DEFAULT_EXECUTION_LIMITS } = await import('../src/domain/execution-control.js')
  const directory = await mkdtemp(join(tmpdir(), 'mcp-process-'))
  const abort = new AbortController()
  const process = new SharedMcpProcess({ dataRoot: directory } as import('../src/domain/community-config.js').CommunityRuntimeConfig, { isolated: false, containerConfig: undefined }, { get: () => DEFAULT_EXECUTION_LIMITS })
  try {
    const handle = await process.start({ name: 'p-fixture', description: '', url: '', generation: 1, prepared: { directory }, credential: 'fictional', run: { location: 'shared', command: 'node', args: ['-e', 'process.stdin.resume()'], env: [{ name: 'KEY', value: '{credential}' }], prepareCommand: '' } }, () => {}, abort.signal)
    expect(process.isolated).toBe(false)
    expect((await fetch(handle.target.baseUrl)).status).toBe(401)
    abort.abort(); await handle.closed
    await expect(fetch(handle.target.baseUrl)).rejects.toThrow()
  } finally { abort.abort(); await rm(directory, { recursive: true, force: true }) }
})

it('translates explicit cancellation to the stdio request ID while its HTTP response remains open', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-cancel-'))
  await writeFile(join(directory, 'server.mjs'), `import {createInterface} from 'node:readline'; const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');let pending;
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'fixture',version:'1'}}});
else if(m.method==='tools/call'){pending=m.id;send({jsonrpc:'2.0',method:'notifications/message',params:{data:'started'}})}
else if(m.method==='notifications/cancelled')send({jsonrpc:'2.0',id:pending,result:{cancelled:m.params.requestId===pending}});
}`)
  const child = spawn(process.execPath, ['--input-type=module', '-e', sharedMcpBridge], { stdio: ['pipe', 'pipe', 'pipe'] }), exited = once(child, 'exit'); child.stderr.resume()
  child.stdin.end(JSON.stringify({ token: 'private', directory, command: process.execPath, args: ['server.mjs'], environment: {}, port: 0, host: '127.0.0.1' }))
  try {
    const ready = JSON.parse((await createInterface({ input: child.stdout })[Symbol.asyncIterator]().next()).value!)
    const headers: Record<string, string> = { authorization: 'Bearer private', 'content-type': 'application/json' }
    const send = (value: unknown) => fetch(`http://127.0.0.1:${ready.port}/mcp`, { method: 'POST', headers, body: JSON.stringify(value) })
    const init = await send({ jsonrpc: '2.0', id: 'init', method: 'initialize' }); headers['mcp-session-id'] = init.headers.get('mcp-session-id')!; await init.text()
    const response = await send({ jsonrpc: '2.0', id: 'call-a', method: 'tools/call', params: { name: 'search' } }), reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('started')
    expect((await send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-a' } })).status).toBe(202)
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"cancelled":true')
    await reader.cancel()
  } finally { child.kill('SIGKILL'); await exited; await rm(directory, { recursive: true, force: true }) }
})

it('distinguishes a real child exit during a request from explicit client cancellation', async () => {
  const { SharedMcpProcess } = await import('../src/adapters/mcp-shared-process.js')
  const { McpSharedRuntime } = await import('../src/use-cases/mcp-shared-runtime.js')
  const { ExecutionControl } = await import('../src/use-cases/execution-control.js')
  const { ExecutionDeadlines } = await import('../src/adapters/execution-control-store.js')
  const { DEFAULT_EXECUTION_LIMITS } = await import('../src/domain/execution-control.js')
  const directory = await mkdtemp(join(tmpdir(), 'mcp-exit-'))
  const records: import('../src/domain/execution-control.js').ExecutionRecord[] = []
  const limits = { get: () => DEFAULT_EXECUTION_LIMITS, save() {} }
  const control = new ExecutionControl(limits, { append: row => { records.push(row) }, list: () => records, prune() {} }, { now: () => 0 }, new ExecutionDeadlines())
  const process = new SharedMcpProcess({ dataRoot: directory } as import('../src/domain/community-config.js').CommunityRuntimeConfig, { isolated: false, containerConfig: undefined }, limits)
  const service = { name: 'p-exit', description: '', url: '', generation: 1, prepared: { directory }, run: { location: 'shared' as const, command: 'node', args: ['server.mjs'], env: [], prepareCommand: '' } }
  const runtime = new McpSharedRuntime(process, control, { now: () => 0 }, { start: () => () => {} }, () => service)
  await writeFile(join(directory, 'server.mjs'), `import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.method==='initialize'&&!m.params?.silent)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-03-26',capabilities:{}}})+'\\n');else if(m.params?.name==='exit')process.exit(17)}`)
  try {
    for (const [index, mode] of ['exit', 'hold', 'initialize'].entries()) {
      const target = await runtime.connect('alice', service, false)
      const headers: Record<string, string> = { authorization: target.headers[0]!.value, 'content-type': 'application/json' }
      const abort = new AbortController()
      const init = await fetch(target.baseUrl, { method: 'POST', headers, signal: abort.signal, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { silent: mode === 'initialize' } }) })
      if (mode === 'initialize') {
        const result = init.text().catch(() => ''); abort.abort(); await result
        await expect.poll(() => records.length).toBe(index + 1); expect(records.at(-1)?.reason).toBe('cancelled'); continue
      }
      headers['mcp-session-id'] = init.headers.get('mcp-session-id')!; await init.text()
      const response = await fetch(target.baseUrl, { method: 'POST', headers, signal: abort.signal, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: mode } }) })
      const finished = response.text().catch(() => '')
      if (mode === 'hold') abort.abort()
      await finished
      await expect.poll(() => records.length).toBe(index + 1)
      expect(records.at(-1)?.reason).toBe(mode === 'exit' ? 'process-exited' : 'cancelled')
      await expect.poll(() => process.retainedArtifacts(), { timeout: 5000 }).toEqual([])
    }
  } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }) }
})

it.each([{ state: 'removed', vanishes: true }, { state: 'still present', vanishes: false }])('verifies container absence after an inspection failure ($state)', async ({ vanishes }) => {
  const { chmod } = await import('node:fs/promises')
  const { SharedMcpProcess } = await import('../src/adapters/mcp-shared-process.js')
  const { DEFAULT_EXECUTION_LIMITS } = await import('../src/domain/execution-control.js')
  const root = await mkdtemp(join(tmpdir(), 'mcp-removal-race-'))
  const runtime = join(root, 'container-cli'), state = join(root, 'state')
  await writeFile(runtime, `#!${process.execPath}
import {existsSync,writeFileSync,unlinkSync} from 'node:fs';
const state=${JSON.stringify(state)}, args=process.argv.slice(2);
if(args[0]==='run'){writeFileSync(state,'present');console.log(JSON.stringify({port:3010}));process.stdin.resume();process.stdin.on('end',()=>setInterval(()=>{},1000))}
else if(args[0]==='port')console.log('127.0.0.1:3010');
else if(args[0]==='ps'){if(existsSync(state))console.log('abcdef123456')}
else if(args[0]==='inspect'){if(${vanishes}&&existsSync(state))unlinkSync(state);console.error('container no longer exists');process.exitCode=125}
else if(args[0]==='rm'){if(existsSync(state))unlinkSync(state)}
`)
  await chmod(runtime, 0o700)
  const carrier = new SharedMcpProcess({ dataRoot: root } as import('../src/domain/community-config.js').CommunityRuntimeConfig, { isolated: true, containerConfig: { runtime, image: 'fixture', internalPort: 3010, gatewayPort: 3011 } }, { get: () => DEFAULT_EXECUTION_LIMITS })
  const service = { name: 'p-race', description: '', url: '', generation: 1, prepared: { directory: root }, run: { location: 'shared' as const, command: 'node', args: [], env: [], prepareCommand: '' } }
  // The fake CLI models ps observing our carrier before --rm makes inspect fail.
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const abort = new AbortController(), handle = await carrier.start(service, () => {}, abort.signal)
      abort.abort()
      if (!vanishes) {
        await expect(handle.closed).rejects.toMatchObject({ code: 125 })
        await expect(carrier.start(service, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'not-ready' })
        break
      }
      await expect(handle.closed).resolves.toBeTypeOf('number')
      expect(carrier.retainedArtifacts()).toEqual([])
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('flushes a large old-version response before reporting completion to a terminating owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-flush-'))
  await writeFile(join(directory, 'server.mjs'), `import {createInterface} from 'node:readline';for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{}}:{content:[{type:'text',text:'x'.repeat(8*1024*1024)}]}})+'\\n')}`)
  const child = spawn(process.execPath, ['--input-type=module', '-e', sharedMcpBridge], { stdio: ['pipe', 'pipe', 'pipe'] }), exited = once(child, 'exit'); child.stderr.resume()
  child.stdin.end(JSON.stringify({ token: 'private', directory, command: process.execPath, args: ['server.mjs'], environment: {}, port: 0, host: '127.0.0.1' }))
  let listening!: (port: number) => void
  const port = new Promise<number>(resolve => { listening = resolve })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => { const event = JSON.parse(line); if (event.port) listening(event.port); if (event.type === 'completed' && event.id === 2) child.kill('SIGTERM') })
  try {
    const url = `http://127.0.0.1:${await port}/mcp`, headers: Record<string, string> = { authorization: 'Bearer private', 'content-type': 'application/json' }
    const send = (id: number, method: string) => fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method }) })
    const init = await send(1, 'initialize'); headers['mcp-session-id'] = init.headers.get('mcp-session-id')!; await init.text()
    const response = await send(2, 'tools/call')
    const body = await response.text()
    expect(JSON.parse(body.slice(6).trim()).result.content[0].text.length).toBe(8 * 1024 * 1024)
    await exited
  } finally { child.kill('SIGKILL'); await exited; lines.close(); await rm(directory, { recursive: true, force: true }) }
})
