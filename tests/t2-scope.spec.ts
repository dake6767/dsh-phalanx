import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('uses business e2e subsets while shared fixtures, build inputs, removed cases and unavailable diffs require full acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 't2-scope-')),
    script = resolve('scripts/validation/t2-plan.mjs')
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim()
  }
  const put = async (file: string, value: string) => {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), value)
  }
  const commit = () => {
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  const plan = (base: string, head: string) => {
    const r = spawnSync(process.execPath, [script, '--pr', base, head], { cwd: root, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    return JSON.parse(r.stdout)
  }
  try {
    git('init', '-q')
    await put('tests/community-experts.e2e.ts', 'before')
    const base = commit()
    await put('tests/community-experts.e2e.ts', 'after')
    const feature = commit()
    expect(plan(base, feature)).toMatchObject({ mode: 'subset', shards: [{ files: ['tests/community-experts.e2e.ts'] }] })
    for (const path of [
      'tests/fixtures/shared.ts',
      'tests/support/shared.ts',
      'vitest.e2e.config.ts',
      'package.json',
      'src/adapters/community-runtime-driver.ts',
    ]) {
      git('reset', '--hard', base)
      await put(path, 'new')
      expect(plan(base, commit()).mode).toBe('full')
    }
    git('reset', '--hard', base)
    await rm(join(root, 'tests/community-experts.e2e.ts'))
    expect(plan(base, commit()).mode).toBe('full')
    git('reset', '--hard', base)
    await put('tests/community-experts-real.e2e.ts', 'T4')
    expect(plan(base, commit()).mode).toBe('none')
    expect(plan('f'.repeat(40), base).mode).toBe('full')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
