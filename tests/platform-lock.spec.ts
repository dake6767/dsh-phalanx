import { fork } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { PlatformLock, PlatformMaintenanceBusyError } from '../src/adapters/platform-lock.js'
it('excludes another process and releases the OS lock after an abrupt process death', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-phalanx-lock-'))
  const script = join(root, 'hold.mjs')
  await writeFile(script, `import { PlatformLock } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/adapters/platform-lock.ts')).href)};\nnew PlatformLock(process.argv[2]); process.send('locked'); setInterval(() => {}, 1000);\n`)
  const child = fork(script, [root], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  try {
    await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('lock fixture exited before ready'))) })
    expect(() => new PlatformLock(root)).toThrow(PlatformMaintenanceBusyError)
    const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()) }); child.kill('SIGKILL'); await exited
    const lock = new PlatformLock(root)
    expect(() => new PlatformLock(root)).toThrow(PlatformMaintenanceBusyError)
    lock.close()
    const next = new PlatformLock(root); next.close()
  } finally { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
})
