import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DevelopmentExecutionProcess } from '../src/adapters/execution-development-process.js'

it('runs literal commands in development with binary streams and terminates cancelled work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-development-'))
  await mkdir(join(root, 'workspace'))
  const process = new DevelopmentExecutionProcess()
  const events: Uint8Array[] = [], controller = new AbortController()
  const input = { mounts: [{ host: join(root, 'workspace'), mounted: '/workspace' }], cwd: '/workspace', command: globalThis.process.execPath,
    argv: ['-e', "require('node:fs').writeFileSync('owned.txt','owned');process.stdout.write(Buffer.from([0,255,1]));process.stderr.write('error');process.exitCode=7"], environment: { PATH: '/usr/bin:/bin', KEY: 'fictional-private-key' }, stdin: new Uint8Array() }
  try {
    expect(await process.run(input, async event => { events.push(event.data) }, controller.signal)).toBe(7)
    expect(Buffer.concat(events).includes(Buffer.from([0, 255, 1]))).toBe(true)
    expect(await readFile(join(root, 'workspace/owned.txt'), 'utf8')).toBe('owned')
    const early = new AbortController()
    const cancelled = process.run({ ...input, argv: ['-e', "require('node:fs').writeFileSync('must-not-start','bad')"] }, async () => {}, early.signal)
    early.abort()
    await expect(cancelled).rejects.toBeDefined()
    await expect(readFile(join(root, 'workspace/must-not-start'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(process.run({ ...input, argv: ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"] }, async () => { controller.abort() }, controller.signal)).rejects.toBeDefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps host-prepared virtualenv entry points executable after freezing dependencies', async () => {
  const { FileExecutionArtifacts } = await import('../src/adapters/execution-artifacts.js')
  const root = await mkdtemp(join(tmpdir(), 'development-preparation-')), artifacts = new FileExecutionArtifacts(root)
  const process = new DevelopmentExecutionProcess(), stage = await artifacts.stage()
  const signal = new AbortController().signal, output: string[] = []
  try {
    expect(await process.run({ mounts: [{ host: stage.directory, mounted: '/artifact' }], cwd: '/artifact', command: 'python3', argv: ['-m', 'venv', '.venv'], stdin: new Uint8Array(), environment: { PATH: '/usr/bin:/bin' } }, async () => {}, signal)).toBe(0)
    const prepared = await artifacts.publish(stage, 'v1', 'identity', '')
    expect(await process.run({ mounts: [{ host: artifacts.directory(prepared.id), mounted: '/artifact' }], cwd: '/artifact', command: '/artifact/.venv/bin/pip', argv: ['--version'], stdin: new Uint8Array(), environment: { PATH: '/usr/bin:/bin' } }, async event => { output.push(Buffer.from(event.data).toString()) }, signal)).toBe(0)
    expect(output.join('')).toContain('pip ')
  } finally { await artifacts.collect([]); await rm(root, { recursive: true, force: true }) }
}, 30000)
