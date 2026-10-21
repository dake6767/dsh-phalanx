import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { startPlatformCli } from './support/platform-cli.js'

it.each([undefined, 'https://app.example.test:19443'])('recognizes actual public CLI readiness for %s', async publicOrigin => {
  const root = await mkdtemp(join(tmpdir(), 'platform-readiness-'))
  let cli: Awaited<ReturnType<typeof startPlatformCli>> | undefined
  try {
    cli = await startPlatformCli(process.execPath, ['--import', 'tsx', resolve('src/composition/cli.ts')], {
      DSH_PHALANX_HOST: '127.0.0.1', DSH_PHALANX_PORT: '0', DSH_PHALANX_DATA_ROOT: root,
      DSH_PHALANX_SESSION_SECRET: 'public-cli-readiness-fixture-32-bytes',
      DSH_PHALANX_RUNTIME_COMMAND: '/unavailable-dsh', DSH_PHALANX_RUNTIME_ARGS_JSON: '[]',
      DSH_PHALANX_ALLOWED_MODEL_PROVIDER: 'deepseek-official', DSH_PHALANX_ALLOWED_MODEL: 'deepseek-chat',
      DSH_PHALANX_MODEL_UPSTREAM_BASE_URL: 'https://api.deepseek.com',
      ...(publicOrigin === undefined ? {} : { DSH_PHALANX_PUBLIC_ORIGIN: publicOrigin }),
    })
    if (publicOrigin === undefined) expect(cli.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    else expect(cli.origin).toBe(publicOrigin)
  } finally { await cli?.stop(); await rm(root, { recursive: true, force: true }) }
}, 45_000)

it('reports a bounded redacted diagnostic when a CLI exits before readiness', async () => {
  await expect(startPlatformCli(process.execPath, ['-e', 'console.error("fixture startup failed " + process.env.FIXTURE_SECRET + " ?token=private-query");process.exit(1)'], { FIXTURE_SECRET: 'private-fixture-secret' })).rejects.toThrow('fixture startup failed [redacted] ?token=[redacted]')
})


it.each(['environment', 'Bearer', 'URL'])('omits oversized %s diagnostics without leaking a truncated credential', async kind => {
  const credential = 'fictional-sensitive-prefix-' + 'private-suffix-'.repeat(400)
  const value = kind === 'Bearer' ? 'Bearer ' + credential : kind === 'URL' ? 'https://user:' + credential + '@example.test/' : credential
  let failure: unknown
  try {
    await startPlatformCli(process.execPath, ['-e', 'process.stderr.write(process.env.FIXTURE_OUTPUT);process.exit(1)'], {
      FIXTURE_OUTPUT: value, ...(kind === 'environment' ? { FIXTURE_SECRET: credential } : {}),
    })
  } catch (error) { failure = error }
  expect(String(failure)).toContain('[stderr omitted: output exceeded 4096 characters]')
  expect(String(failure)).not.toContain('private-suffix-')
})
