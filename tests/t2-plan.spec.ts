import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import inventory from '../scripts/validation/t2-selection.json' with { type: 'json' }

const invoke = (...args: string[]) => spawnSync(process.execPath, ['scripts/validation/t2-plan.mjs', ...args], { encoding: 'utf8' })
it('distributes every installed case once over four independent runners and owns migration exactly once', () => {
  const run = invoke(); expect(run.status, run.stderr).toBe(0)
  const plan = JSON.parse(run.stdout)
  expect(plan.mode).toBe('full'); expect(plan.shards).toHaveLength(4)
  expect(plan.shards.flatMap((row: { files: string[] }) => row.files).sort()).toEqual([...inventory.regular].sort())
  expect(plan.shards.map((row: { cases: number }) => row.cases)).toEqual([21, 21, 21, 20])
  expect(plan.shards.filter((row: { migration: boolean }) => row.migration)).toHaveLength(1)
  expect(invoke().stdout).toBe(run.stdout)
})

it('keeps explicit subsets on one runner and rejects invalid inventory and mixed execution modes', () => {
  const subset = invoke('--files', 'tests/installed-candidate.e2e.ts')
  expect(subset.status, subset.stderr).toBe(0)
  expect(JSON.parse(subset.stdout)).toMatchObject({ mode: 'subset', shards: [{ index: 1, total: 1, migration: false, files: ['tests/installed-candidate.e2e.ts'] }] })
  for (const files of ['', 'tests/not-listed.e2e.ts', 'tests/installed-candidate.e2e.ts,tests/installed-candidate.e2e.ts']) expect(invoke('--files', files).status).not.toBe(0)
  for (const args of [['--smoke', '--shard', '1/4'], ['--files', 'tests/installed-candidate.e2e.ts', '--shard', '1/4'], ['--shard', '0/4'], ['--shard', '1/3']]) {
    const run = spawnSync(process.execPath, ['scripts/validation/t2.mjs', ...args, '/tmp/results'], { encoding: 'utf8' })
    expect(run.status).not.toBe(0)
    expect(run.stderr).not.toContain('Run T2 as the rootless Linux test identity')
  }
})
