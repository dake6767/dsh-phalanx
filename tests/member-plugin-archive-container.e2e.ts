import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { receiveMemberPluginArchive } from '../src/adapters/member-plugin-archive.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
it.skipIf(!runtimeSettings.containerImage)('cancels a stalled member archive download without a surviving worker or partial cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-cancel-')); const name = 'market-cancel-' + randomUUID()
  const cli = runtimeSettings.containerRuntimeCli
  try {
    await execFileText(cli, ['run', '--detach', '--rm', '--name', name, '--network', 'none', '--userns=keep-id', '--user', `${process.getuid!()}:${process.getgid!()}`,  '--volume', `${root}:/dsh-phalanx/home:rw`, '--entrypoint', 'node', runtimeSettings.containerImage!, '-e', "const fs=require('node:fs');require('node:http').createServer((q,s)=>{fs.writeFileSync('/dsh-phalanx/home/started','yes');s.writeHead(200);s.write('a');s.on('close',()=>fs.writeFileSync('/dsh-phalanx/home/closed','yes'))}).listen(8088,'127.0.0.1',()=>fs.writeFileSync('/dsh-phalanx/home/ready','yes'))"])
    await expect.poll(() => readFile(join(root, 'ready'), 'utf8'), { timeout: 10000 }).toBe('yes')
    const controller = new AbortController()
    const pending = receiveMemberPluginArchive({ runtime: cli, image: runtimeSettings.containerImage!, gatewayPort: 0, internalPort: 0 }, name, 'http://127.0.0.1:8088/archive.tgz', 'sha512-' + createHash('sha512').update('fixture').digest('base64'), controller.signal)
    const rejected = expect(pending).rejects.toBeDefined()
    await expect.poll(() => readFile(join(root, 'started'), 'utf8'), { timeout: 10000 }).toBe('yes')
    controller.abort(); await rejected
    await expect.poll(async () => (await execFileText(cli, ['top', name, 'args'])).includes('Archive integrity mismatch'), { timeout: 5000 }).toBe(false)
    await expect.poll(() => readFile(join(root, 'closed'), 'utf8'), { timeout: 5000 }).toBe('yes')
    expect((await readdir(root)).sort()).toEqual(['closed', 'ready', 'started'])
  } finally { await execFileText(cli, ['rm', '--force', name], { acceptedExitCodes: [1] }); await rm(root, { recursive: true, force: true }) }
}, 60000)
