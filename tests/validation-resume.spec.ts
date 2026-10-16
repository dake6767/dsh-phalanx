import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'

it('resumes a failed acceptance command without repeating passed steps and retains the first failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-resume-'))
  try {
    const invoke = (resume = '') => spawnSync(process.execPath,
      ['--import', 'tsx', 'tests/fixtures/resumable-acceptance.ts', root, resume], { encoding: 'utf8' })
    expect(invoke().status).toBe(1)
    const failed = JSON.parse(await readFile(join(root, 'progress.json'), 'utf8'))
    expect(failed.firstFailure.step).toBe('upgrade')
    expect(invoke('verify').status).toBe(1)
    expect(await readFile(join(root, 'effects.txt'), 'utf8')).toBe('install\nupgrade\n')
    const result = invoke('upgrade')
    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(join(root, 'effects.txt'), 'utf8')).toBe('install\nupgrade\nupgrade\nverify\n')
    const resumed = JSON.parse(await readFile(join(root, 'progress.json'), 'utf8'))
    expect(resumed).toMatchObject({ status: 'passed', resumeFrom: 'upgrade', firstFailure: failed.firstFailure })
    expect(JSON.parse(result.stdout)).toEqual({ preserved: 'baseline member data', verified: true })
  } finally { await rm(root, { recursive: true, force: true }) }
})
