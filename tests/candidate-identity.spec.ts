import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('accepts an exact main-branch source commit independently of the dispatch workflow commit without source tags', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-source-'))
  try {
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
      return result.stdout.trim()
    }
    git('init', '-b', 'main')
    const commit = (message: string) => {
      git('add', '.')
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', message)
      return git('rev-parse', 'HEAD')
    }
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.15' }))
    const legacy = commit('legacy source')
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.16' }))
    const source = commit('candidate source')
    await writeFile(join(root, 'workflow.txt'), 'trusted workflow revision')
    const workflow = commit('workflow revision')
    await writeFile(join(root, 'later.txt'), 'source newer than trusted workflow')
    const future = commit('later source')
    git('update-ref', 'refs/remotes/origin/main', future)
    git('checkout', '--detach', workflow)
    const output = join(root, 'outputs')
    const env = { ...process.env, GITHUB_REPOSITORY: 'dake6767/dsh-phalanx', GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main', GITHUB_SHA: workflow, GITHUB_RUN_ID: '123', GITHUB_OUTPUT: output,
      CANDIDATE_TAG: 'run-123', CANDIDATE_SHA: source }
    const invoke = (changes = {}) => spawnSync(process.execPath, [resolve('scripts/release/candidate.mjs'), 'verify'], {
      cwd: root, env: { ...env, ...changes }, encoding: 'utf8',
    })
    for (const invalid of [{ CANDIDATE_SHA: 'f'.repeat(40) }, { CANDIDATE_SHA: legacy }, { CANDIDATE_SHA: future }, { CANDIDATE_TAG: 'run-124' },
      { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/topic' }, { GITHUB_SHA: source }]) {
      expect(invoke(invalid).status).not.toBe(0)
    }
    const result = invoke()
    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(output, 'utf8')).toContain(`commit=${source}\n`)
    expect(git('tag', '--list')).toBe('')
  } finally { await rm(root, { recursive: true, force: true }) }
})
