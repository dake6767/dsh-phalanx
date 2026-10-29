import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('preserves the runtime PID and closes its pipes when the caller kills that PID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-runtime-pid-'))
  try {
    const runtime = join(root, 'fake-podman')
    await writeFile(
      runtime,
      `#!/usr/bin/env python3
import os,sys,time
from pathlib import Path
if sys.argv[1]=='run':
 Path(${JSON.stringify(join(root, 'pid'))}).write_text(str(os.getpid()))
 print('ready',flush=True)
 while True:time.sleep(1)
if sys.argv[1]=='ps':print('[]')
`,
      { mode: 0o700 },
    )
    const command = `import {spawn} from 'node:child_process';import {once} from 'node:events';import {readFileSync} from 'node:fs';
const child=spawn('podman',['run','image'],{stdio:['ignore','pipe','pipe']});await once(child.stdout,'data');
const runtimePid=Number(readFileSync(${JSON.stringify(join(root, 'pid'))},'utf8'));
if(runtimePid!==child.pid){console.log(JSON.stringify({pid:child.pid,runtimePid,closed:false}));process.exit(42)}
const closing=once(child,'close');child.kill('SIGKILL');await closing;console.log(JSON.stringify({pid:child.pid,runtimePid,closed:true}));`
    const module = new URL(`file://${resolve('scripts/validation/file-runner.mjs')}`).href
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {runFile} from ${JSON.stringify(module)};console.log(JSON.stringify(await runFile({file:'pid',index:104,directory:${JSON.stringify(root)}+'/run',command:[process.execPath,'--input-type=module','-e',${JSON.stringify(command)}]})));`,
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, DSH_PHALANX_CONTAINER_RUNTIME: runtime },
      },
    )
    expect(result.status, result.stderr).toBe(0)
    const execution = JSON.parse(result.stdout.trim())
    expect(execution.status).toBe('passed')
    const signal = JSON.parse((await readFile(join(root, 'run/output.log'), 'utf8')).trim())
    expect(signal.pid).toBe(signal.runtimePid)
    expect(signal.closed).toBe(true)
    expect(execution.cleanup.passed).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('keeps host temporary files isolated while container processes use their own temporary directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-container-tmp-'))
  try {
    const runtime = join(root, 'fake-podman')
    await writeFile(
      runtime,
      `#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
with open(${JSON.stringify(join(root, 'calls'))},'a') as f:f.write(json.dumps({'args':args,'tmp':os.environ.get('TMPDIR')})+'\\n')
if args[0]=='ps':print('[]')
if args[0]=='create' and os.environ.get('TMPDIR')!='/tmp':sys.exit(65)
`,
      { mode: 0o700 },
    )
    const module = new URL(`file://${resolve('scripts/validation/file-runner.mjs')}`).href
    const command = `console.log('host-temp='+process.env.TMPDIR);const {spawnSync}=require('node:child_process');spawnSync('podman',['inspect','image']);const r=spawnSync('podman',['create','--env','TMPDIR','image']);process.exit(r.status??1)`
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {runFile} from ${JSON.stringify(module)};console.log(JSON.stringify(await runFile({file:'temporary',index:103,directory:${JSON.stringify(root)}+'/run',command:[process.execPath,'-e',${JSON.stringify(command)}]})));`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, DSH_PHALANX_CONTAINER_RUNTIME: runtime },
      },
    )
    expect(result.status, result.stderr).toBe(0)
    const execution = JSON.parse(result.stdout.trim())
    expect(execution.status).toBe('passed')
    expect(await readFile(join(root, 'run/output.log'), 'utf8')).toContain('host-temp=' + join(root, 'run/tmp'))
    const calls: { args: string[]; tmp: string }[] = (await readFile(join(root, 'calls'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(calls.find(row => row.args[0] === 'create')?.tmp).toBe('/tmp')
    expect(calls.find(row => row.args[0] === 'inspect')?.tmp).toBe(join(root, 'run/tmp'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('isolates a timed-out process group and preserves diagnostics before the next file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-runner-'))
  try {
    await writeFile(
      join(root, 'hang.mjs'),
      `import {spawn} from 'node:child_process'; import net from 'node:net'; import {appendFileSync} from 'node:fs';
process.on('SIGTERM',()=>{});const server=net.createServer();server.listen(Number(process.env.DSH_PHALANX_E2E_PORT_BASE)+1,'127.0.0.1',()=>{
const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});appendFileSync(process.env.DSH_PHALANX_PROCESS_GROUPS_FILE,JSON.stringify({pid:child.pid})+'\\n');console.log('ready');});`,
    )
    const module = new URL(`file://${resolve('scripts/validation/file-runner.mjs')}`).href
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {runFile} from ${JSON.stringify(module)};
const root=${JSON.stringify(root)};
const first=await runFile({file:'hang',index:100,directory:root+'/first',command:[process.execPath,root+'/hang.mjs'],timeoutMs:1000});
const next=await runFile({file:'next',index:100,directory:root+'/next',command:[process.execPath,'-e','console.log("next passed")']});
console.log(JSON.stringify({first,next}));`,
      ],
      { encoding: 'utf8', timeout: 15000 },
    )
    expect(result.status, result.stderr).toBe(0)
    const { first, next } = JSON.parse(result.stdout.trim())
    expect(first.status).toBe('failed')
    expect(first.timedOut).toBe(true)
    expect(first.cleanup.passed).toBe(true)
    expect(next.status).toBe('passed')
    const diagnostics = JSON.parse(await readFile(join(root, 'first/diagnostics.json'), 'utf8'))
    expect(diagnostics.processes).toContain('setInterval')
    expect(await readFile(join(root, 'first/output.log'), 'utf8')).toContain('ready')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('records a foreign port owner without killing it and continues on the next range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-ports-'))
  try {
    const module = new URL(`file://${resolve('scripts/validation/file-runner.mjs')}`).href
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import net from 'node:net';import {runFile} from ${JSON.stringify(module)};
const server=net.createServer();await new Promise(r=>server.listen(22001,'127.0.0.1',r));
try { const first=await runFile({file:'busy',index:100,directory:${JSON.stringify(root)}+'/first',command:[process.execPath,'-e','throw Error("must not launch")']});
const next=await runFile({file:'next',index:101,directory:${JSON.stringify(root)}+'/next',command:[process.execPath,'-e','process.exit(0)']});
console.log(JSON.stringify({first,next,ownerAlive:server.listening})); } finally {server.close();}`,
      ],
      { encoding: 'utf8', timeout: 15000 },
    )
    expect(result.status, result.stderr).toBe(0)
    const { first, next, ownerAlive } = JSON.parse(result.stdout.trim())
    expect(first.status).toBe('environment-failed')
    expect(first.busyPorts).toContain(22001)
    expect(first.ownerDetails).toContain(String(result.pid))
    expect(ownerAlive).toBe(true)
    expect(next.status).toBe('passed')
    expect(next.portBase).toBe(22020)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('collects labelled container logs before removal and attempts every owned container', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-containers-'))
  try {
    const runtime = join(root, 'fake-podman')
    await writeFile(
      runtime,
      `#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
with open(${JSON.stringify(join(root, 'calls'))},'a') as f:f.write(json.dumps(args)+'\\n')
if args[0]=='ps':
 assert args[3].startswith('label=dsh.validation.file=')
 print(json.dumps([{'Id':'owned-a'},{'Id':'owned-b'}]))
if args[0]=='rm' and args[-1]=='owned-a':sys.exit(1)
`,
      { mode: 0o700 },
    )
    const module = new URL(`file://${resolve('scripts/validation/file-runner.mjs')}`).href
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {runFile} from ${JSON.stringify(module)};
console.log(JSON.stringify(await runFile({file:'containers',index:102,directory:${JSON.stringify(root)}+'/run',command:[process.execPath,'-e',"require('node:child_process').spawnSync('podman',['create','image'],{env:{PATH:process.env.PATH,HOME:process.env.HOME}})"]})));`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, DSH_PHALANX_CONTAINER_RUNTIME: runtime, CALLS: join(root, 'calls') },
      },
    )
    expect(result.status, result.stderr).toBe(0)
    const execution = JSON.parse(result.stdout.trim())
    expect(execution.status).toBe('environment-failed')
    const calls: string[][] = (await readFile(join(root, 'calls'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(calls.find(row => row[0] === 'create')?.[1]).toBe('--label')
    expect(calls.find(row => row[0] === 'create')?.[2]).toMatch(/^dsh.validation.file=[a-f0-9]{64}$/u)
    expect(calls.filter(row => row[0] === 'rm').map(row => row.at(-1))).toEqual(['owned-a', 'owned-b'])
    expect(calls.findIndex(row => row[0] === 'logs' && row[1] === 'owned-b')).toBeLessThan(calls.findIndex(row => row[0] === 'rm'))
    expect(calls.flat()).not.toContain('foreign')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('discards regenerable compiler caches only after a passed file and keeps failed temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-caches-'))
  try {
    const write = `const {mkdirSync,writeFileSync}=require('node:fs'),{join}=require('node:path'),t=process.env.TMPDIR;
for (const d of ['node-compile-cache/v24','AbCdEfGhIjKlMnOpQrStU/ssr','AbCdEfGhIjKlMnOpQrStV/ssr']) mkdirSync(join(t,d),{recursive:true});
writeFileSync(join(t,'node-compile-cache/v24/a'),'x');writeFileSync(join(t,'AbCdEfGhIjKlMnOpQrStU/ssr/b'),'x');
writeFileSync(join(t,'AbCdEfGhIjKlMnOpQrStV/kept'),'x');writeFileSync(join(t,'evidence.json'),'{}');`
    const module = new URL(`file://${resolve('scripts/validation/file-runner.mjs')}`).href
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {runFile} from ${JSON.stringify(module)};
const root=${JSON.stringify(root)}, write=${JSON.stringify(write)};
const passed=await runFile({file:'passed',index:105,directory:root+'/passed',containerChecks:false,command:[process.execPath,'-e',write]});
const failed=await runFile({file:'failed',index:105,directory:root+'/failed',containerChecks:false,command:[process.execPath,'-e',write+'process.exit(1)']});
console.log(JSON.stringify({passed:passed.status,failed:failed.status}));`,
      ],
      { encoding: 'utf8', timeout: 15000 },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual({ passed: 'passed', failed: 'failed' })
    expect((await readdir(join(root, 'passed/tmp'))).sort()).toEqual(['AbCdEfGhIjKlMnOpQrStV', 'evidence.json'])
    expect(await readdir(join(root, 'passed/tmp/AbCdEfGhIjKlMnOpQrStV'))).toEqual(['kept'])
    expect((await readdir(join(root, 'failed/tmp'))).sort()).toEqual(['AbCdEfGhIjKlMnOpQrStU', 'AbCdEfGhIjKlMnOpQrStV', 'evidence.json', 'node-compile-cache'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
