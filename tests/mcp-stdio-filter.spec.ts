import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { serveMemberMcpInput } from './support/mcp-member-input.js'
import { memberMcpFilter } from '../src/dsh/mcp-stdio-filter.js'

it.each(['transformed', 'development'])('filters prepared stdio tools and preserves bidirectional messages (%s)', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-stdio-'))
  const fixture = `import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
process.stderr.write(process.env.PRIVATE_KEY.slice(0, 12)); setImmediate(() => process.stderr.write(process.env.PRIVATE_KEY.slice(12)));
for await (const line of createInterface({input:process.stdin})) {
 const row=JSON.parse(line); const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
 if(row.method==='initialize') {send({jsonrpc:'2.0',id:row.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}}}});send({jsonrpc:'2.0',id:'server',method:'ping'});}
 else if(row.id==='server') send({jsonrpc:'2.0',method:'notifications/accepted'});
 else if(row.method==='tools/list') send({jsonrpc:'2.0',id:row.id,result:{tools:[{name:'read'},{name:'write'}],nextCursor:'second'}});
 else if(row.method==='tools/call') send({jsonrpc:'2.0',id:row.id,result:{content:[{type:'text',text:row.params.name+' called '+spawnSync('path-marker',[],{encoding:'utf8'}).stdout}]}});
}`
  await writeFile(join(root, 'server.mjs'), fixture)
  const source =
    mode === 'development'
      ? (
          await promisify(execFile)(process.execPath, [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            'import {memberMcpFilter} from "./src/dsh/mcp-stdio-filter.ts";process.stdout.write(memberMcpFilter)',
          ])
        ).stdout
      : memberMcpFilter
  await writeFile(join(root, 'filter.mjs'), source)
  await mkdir(join(root, 'custom'))
  await writeFile(join(root, 'custom', 'path-marker'), '#!/bin/sh\nprintf configured-path', { mode: 0o755 })
  await mkdir(join(root, 'node_modules', 'fixture-mcp'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'fixture-mcp', 'package.json'), JSON.stringify({ name: 'fixture-mcp', version: '1.2.3', bin: '../../server.mjs' }))
  const gateway = await serveMemberMcpInput({
    directory: root,
    command: 'npx',
    args: ['-y', 'fixture-mcp@latest'],
    env: [
      { name: 'PRIVATE_KEY', value: 'fictional-member-runtime-stderr-key' },
      { name: 'npm_config_offline', value: 'true' },
      { name: 'PATH', value: root + '/custom:/usr/bin:/bin' },
    ],
    disabledTools: ['write'],
  })
  const child = spawn(process.execPath, [join(root, 'filter.mjs'), gateway.reference], {
    env: { ...process.env, ...gateway.environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator](),
    exited = once(child, 'close')
  let errors = ''
  child.stderr.on('data', chunk => {
    errors += chunk.toString()
  })
  const send = (row: unknown) => child.stdin.write(JSON.stringify(row) + '\n')
  const read = async () => {
    const row = await lines.next()
    if (row.done) throw Error('stdio ended: ' + errors)
    return JSON.parse(row.value)
  }
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(await read()).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26' } })
    expect(await read()).toMatchObject({ id: 'server', method: 'ping' })
    send({ jsonrpc: '2.0', id: 'server', result: {} })
    expect(await read()).toMatchObject({ method: 'notifications/accepted' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(await read()).toMatchObject({ id: 2, result: { tools: [{ name: 'read' }], nextCursor: 'second' } })
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write' } })
    expect(await read()).toMatchObject({ id: 3, error: { code: -32602 } })
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read' } })
    expect(await read()).toMatchObject({ id: 4, result: { content: [{ text: 'read called configured-path' }] } })
    child.stdin.end()
    expect((await exited)[0]).toBe(0)
    expect(errors).not.toContain('fictional-member-runtime-stderr-key')
    expect(errors).toContain('[redacted]')
  } finally {
    child.kill('SIGKILL')
    await exited
    await gateway.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['eof', 'invalid', 'signal'])('reclaims MCP descendants when the wrapper ends (%s)', async ending => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-descendants-'))
  await writeFile(join(root, 'filter.mjs'), memberMcpFilter)
  await writeFile(
    join(root, 'server.mjs'),
    `import {spawn} from 'node:child_process'; import {createInterface} from 'node:readline';
const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});descendant.unref();
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{pid:descendant.pid}})+'\\n');
createInterface({input:process.stdin}).on('close',()=>process.exit(0));`,
  )
  const gateway = await serveMemberMcpInput({ directory: root, command: process.execPath, args: [join(root, 'server.mjs')], env: [], disabledTools: [] })
  const child = spawn(process.execPath, [join(root, 'filter.mjs'), gateway.reference], {
    env: { ...process.env, ...gateway.environment },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const exited = once(child, 'close'),
    lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let pid: number | undefined
  try {
    pid = JSON.parse((await lines.next()).value!).result.pid
    if (ending === 'eof') child.stdin.end()
    else if (ending === 'invalid') child.stdin.write('{\n')
    else child.kill('SIGTERM')
    await exited
    await expect
      .poll(() => {
        try {
          process.kill(pid!, 0)
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          return false
        }
      })
      .toBe(false)
  } finally {
    child.kill('SIGKILL')
    await exited
    if (pid) killRemaining(pid)
    await gateway.close()
    await rm(root, { recursive: true, force: true })
  }
})

function killRemaining(pid: number) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

it('reaps a stubborn server before the official client escalates from EOF and TERM to KILL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-sdk-close-'))
  await writeFile(join(root, 'filter.mjs'), memberMcpFilter)
  await writeFile(
    join(root, 'server.mjs'),
    `process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{pid:process.pid}})+'\\n')`,
  )
  const gateway = await serveMemberMcpInput({ directory: root, command: process.execPath, args: [join(root, 'server.mjs')], env: [] })
  const child = spawn(process.execPath, [join(root, 'filter.mjs'), gateway.reference], {
    env: { ...process.env, ...gateway.environment },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const exited = once(child, 'close'),
    lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let pid: number | undefined
  let term: ReturnType<typeof setTimeout> | undefined, hard: ReturnType<typeof setTimeout> | undefined
  try {
    pid = JSON.parse((await lines.next()).value!).result.pid
    term = setTimeout(() => child.kill('SIGTERM'), 2000)
    hard = setTimeout(() => child.kill('SIGKILL'), 4000)
    child.stdin.end()
    await exited
    expect(() => process.kill(pid!, 0)).toThrow()
  } finally {
    clearTimeout(term)
    clearTimeout(hard)
    child.kill('SIGKILL')
    await exited
    if (pid) killRemaining(pid)
    await gateway.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['eof', 'signal'].flatMap(ending => ['stderr', 'stdout'].map(stream => ({ ending, stream }))))(
  'reclaims the wrapper and its process group with unread output backpressure ($stream/$ending)',
  async ({ ending, stream }) => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-stderr-backpressure-'))
    await writeFile(join(root, 'filter.mjs'), memberMcpFilter)
    await writeFile(
      join(root, 'server.mjs'),
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(root, 'server.pid'))},String(process.pid));process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);${stream === 'stderr' ? 'process.stderr.write(Buffer.alloc(4*1024*1024,120));' : ''}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{pid:process.pid,body:${stream === 'stdout' ? "'x'.repeat(4*1024*1024)" : "''"}}})+'\\n')`,
    )
    const gateway = await serveMemberMcpInput({ directory: root, command: process.execPath, args: [join(root, 'server.mjs')], env: [] })
    const child = spawn(process.execPath, [join(root, 'filter.mjs'), gateway.reference], {
      env: { ...process.env, ...gateway.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = once(child, 'close')
    let pid: number | undefined, hard: ReturnType<typeof setTimeout> | undefined
    try {
      if (stream === 'stderr') pid = JSON.parse((await createInterface({ input: child.stdout })[Symbol.asyncIterator]().next()).value!).result.pid
      else {
        await once(child.stdout, 'readable')
        pid = Number(await readFile(join(root, 'server.pid'), 'utf8'))
      }
      hard = setTimeout(() => child.kill('SIGKILL'), 4000)
      if (ending === 'eof') child.stdin.end()
      else child.kill('SIGTERM')
      const result = await exited
      expect(result[1]).not.toBe('SIGKILL')
      expect(() => process.kill(pid!, 0)).toThrow()
    } finally {
      clearTimeout(hard)
      child.kill('SIGKILL')
      await exited
      child.stderr.destroy()
      child.stdout.destroy()
      if (pid) killRemaining(pid)
      await gateway.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  8000,
)
