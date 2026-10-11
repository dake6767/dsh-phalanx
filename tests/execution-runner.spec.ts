import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { ContainerExecutionRunner } from '../src/adapters/execution-runner.js'

it.each(['request', 'shutdown'])('cleans late container creation and blocked output on %s cancellation', async cancellation => {
  const root = await mkdtemp(join(tmpdir(), 'execution-cancellation-'))
  const cli = join(root, 'container-cli.mjs'), home = join(root, 'home'), workspace = join(root, 'workspace')
  await copyFile(fileURLToPath(new URL('./fixtures/execution-cli.mjs', import.meta.url)), cli); await chmod(cli, 0o700)
  await mkdir(home); await mkdir(workspace)
  const runner = new ContainerExecutionRunner({ dataRoot: root, command: 'node', args: [], defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } }, container: { runtime: cli, image: 'fixture', internalPort: 4180, gatewayPort: 4181 } },
    { assertAvailable() {}, prepare: async () => ({ home, workspace, spaceId: 'member-space' }) }, { directory: () => root })
  const controller = new AbortController()
  let ready!: () => void
  const emitting = new Promise<void>(resolve => { ready = resolve })
  try {
    const running = runner.run({ username: 'member', owner: 'skill:news', version: 'version', command: 'news-cli', argv: [], cwd: '/dsh-phalanx/workspace', stdin: new Uint8Array(), environment: {} }, async event => {
      expect(new TextDecoder().decode(event.data)).toBe('ready-to-cancel'); ready()
      if (cancellation === 'request') controller.abort()
      else await new Promise<void>(() => {})
    }, controller.signal)
    const rejected = expect(running).rejects.toBeDefined()
    await emitting
    if (cancellation === 'shutdown') await runner.stop()
    await rejected
    expect(await readFile(join(root, 'creation-finished'), 'utf8')).toBe('yes')
    await expect(readFile(join(root, 'container'))).rejects.toMatchObject({ code: 'ENOENT' })
    await runner.stop()
  } finally { await rm(root, { recursive: true, force: true }) }
})
