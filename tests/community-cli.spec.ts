import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('rejects unsupported commands without touching a new deployment root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'community-cli-'))
  try {
    const result = await new Promise<{ code: number | string | null | undefined, stderr: string }>(resolve => {
      execFile(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/composition/cli.ts', import.meta.url)),
        'unsupported-command', '--data-root', root], { env: { PATH: process.env.PATH } }, (error, _out, stderr) => resolve({ code: error?.code, stderr }))
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Usage: dsh-phalanx')
    expect(await readdir(root)).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
