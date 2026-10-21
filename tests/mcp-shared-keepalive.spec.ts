import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'
import { sharedMcpBridge } from '../src/adapters/mcp-shared-bridge.js'

it('keeps silent MCP streams alive without reporting activity and releases their timers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-keepalive-'))
  await writeFile(join(directory, 'clock.mjs'), `
const schedule=globalThis.setInterval, cancel=globalThis.clearInterval, pulses=new Set();
globalThis.setInterval=(callback,ms,...args)=>{if(ms!==30000)return schedule(callback,ms,...args);const timer={callback,unref(){}};pulses.add(timer);return timer};
globalThis.clearInterval=timer=>{if(!pulses.delete(timer))cancel(timer)};
process.on('message',message=>{if(message==='pulse')for(const timer of pulses)timer.callback();process.stdout.write(JSON.stringify({probe:true,timers:pulses.size})+'\\n')});
`)
  await writeFile(join(directory, 'server.mjs'), `
import {createInterface} from 'node:readline';let held;const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'fixture',version:'1'}}});
else if(m.method==='tools/call')held=m;
else if(m.method==='notifications/release')send({jsonrpc:'2.0',id:held.id,result:{content:[{type:'text',text:'released'}]}})}
`)
  const bridge = spawn(process.execPath, ['--import', join(directory, 'clock.mjs'), '--input-type=module', '-e', sharedMcpBridge], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  const exited = once(bridge, 'exit'); bridge.stderr!.resume()
  bridge.stdin!.end(JSON.stringify({ token: 'fictional', directory, command: process.execPath, args: ['server.mjs'], environment: {}, port: 0, host: '127.0.0.1' }))
  const lines = createInterface({ input: bridge.stdout! })[Symbol.asyncIterator]()
  const probe = async (command: 'pulse' | 'inspect') => {
    bridge.send(command)
    const events = []
    for (;;) { const event = JSON.parse((await lines.next()).value!); if (event.probe) return { timers: event.timers, events }; events.push(event) }
  }
  try {
    const ready = JSON.parse((await lines.next()).value!), url = `http://127.0.0.1:${ready.port}/mcp`
    const headers: Record<string, string> = { authorization: 'Bearer fictional', 'content-type': 'application/json' }
    const send = (body: unknown) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    const init = await send({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    headers['mcp-session-id'] = init.headers.get('mcp-session-id')!; await init.text()
    const call = await send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hold' } })
    const subscription = await fetch(url, { headers })
    const callReader = call.body!.getReader(), subscriptionReader = subscription.body!.getReader()
    const before = await probe('inspect')
    expect(before.timers).toBe(2)
    expect(before.events).toContainEqual(expect.objectContaining({ type: 'started' }))
    expect(await probe('pulse')).toEqual({ timers: 2, events: [] })
    expect(new TextDecoder().decode((await callReader.read()).value)).toBe(': keepalive\n\n')
    expect(new TextDecoder().decode((await subscriptionReader.read()).value)).toBe(': keepalive\n\n')
    expect((await send({ jsonrpc: '2.0', method: 'notifications/release' })).status).toBe(202)
    expect(new TextDecoder().decode((await callReader.read()).value)).toContain('released')
    expect((await callReader.read()).done).toBe(true)
    expect((await probe('inspect')).timers).toBe(1)
    await subscriptionReader.cancel()
    await expect.poll(async () => (await probe('inspect')).timers).toBe(0)
  } finally { bridge.kill('SIGKILL'); await exited; await rm(directory, { recursive: true, force: true }) }
})
