// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { runtimeSection } from './support/real-dsh-runtime.js'
import { execFileText } from '../src/adapters/runtime-command.js'

it.skipIf(!runtimeSettings.containerImage).each([false, true])(
  'reaps an orphan shared container before collecting its old dependency (cleanup fails: %s)',
  async fail => {
    const root = await mkdtemp(join(tmpdir(), 'dependency-recovery-container-'))
    const old = join(root, 'runtime-dependencies/.trees', 'a'.repeat(64)),
      wrapper = join(root, 'container-cli')
    const ownership = createHash('sha256').update(root).digest('hex'),
      name = 'dependency-orphan-' + randomUUID()
    const cli = runtimeSettings.containerRuntimeCli,
      base = runtimeSection(root, 'https://example.test', runtimeSettings)
    if (!('container' in base)) throw Error('Container runtime is required')
    await mkdir(old, { recursive: true })
    await writeFile(join(old, 'active-input'), 'still-needed')
    // The injected removal failure occurs at the real container CLI boundary.
    await writeFile(
      wrapper,
      `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='rm' && ${fail}){fs.writeFileSync(${JSON.stringify(join(root, 'failed-removal'))},'yes');process.exit(42)}const result=spawnSync(${JSON.stringify(cli)},args,{stdio:'inherit'});process.exit(result.status??1);\n`,
      { mode: 0o700 },
    )
    const app = candidateApplication({
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'dependency-recovery-container-secret',
      runtime: { ...base, container: { ...base.container, runtime: wrapper } },
    })
    try {
      await execFileText(cli, [
        'run',
        '--detach',
        '--name',
        name,
        '--label',
        `dsh-phalanx.mcp-shared=${ownership}`,
        '--network=none',
        '--read-only',
        '--userns=keep-id',
        '--volume',
        `${old}:/dependency:ro`,
        '--entrypoint',
        'sh',
        base.container.image,
        '-c',
        'test -r /dependency/active-input && sleep 600',
      ])
      if (fail) {
        if (process.env.DSH_PHALANX_INSTALL_ROOT !== undefined && base.container !== undefined) {
          const origin = await app.start()
          const login = await fetch(origin + '/login', { signal: AbortSignal.timeout(10_000) })
          expect(login.status).toBe(503)
          await login.arrayBuffer()
          const status = await fetch(origin + '/admin/api/system-status', { signal: AbortSignal.timeout(10_000) })
          expect(status.status).toBe(503)
          expect(await status.json()).toMatchObject({ code: 'platform-configuration-unavailable' })
        } else await expect(app.start()).rejects.toThrow()
        expect(await readFile(join(root, 'failed-removal'), 'utf8')).toBe('yes')
        expect(await readFile(join(old, 'active-input'), 'utf8')).toBe('still-needed')
        expect((await execFileText(cli, ['exec', name, 'cat', '/dependency/active-input'])).trim()).toBe('still-needed')
      } else {
        await app.start()
        expect((await execFileText(cli, ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.ID}}'])).trim()).toBe('')
        await expect(readFile(join(old, 'active-input'))).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      await execFileText(cli, ['rm', '--force', '--ignore', name])
      await app.stop().catch(() => {})
      await removeCommunityFixture(root)
    }
  },
  60000,
)
