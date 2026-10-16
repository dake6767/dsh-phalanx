import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { imageName, sha256 } from '../scripts/release/integrity.mjs'

it('takes the exact T2 image archive into a candidate and rejects changed bytes before adoption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-t2-image-'))
  const archive = 'dsh-phalanx-dsh-linux-amd64.oci.tar'
  const bytes = 'the image archive tested by the successful T2 job'
  const commit = 'b'.repeat(40), digest = `sha256:${'a'.repeat(64)}`
  try {
    const manifest = { schema: 1, tag: 'v0.1.0-rc.123', targetVersion: '0.1.0', commit, platform: 'linux/amd64',
      runId: '123', dshRevision: 'c'.repeat(40), toolchain: { node: '24.21.0', pnpm: '11.19.0' },
      image: { name: imageName, tag: '0.1.0-rc.123', digest, reference: `${imageName}@${digest}` },
      files: { 'dsh-phalanx-linux-amd64.tar.gz': sha256('platform'), [archive]: sha256(bytes) } }
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(root, archive), 'different image bytes')
    const invoke = () => spawnSync(process.execPath, [resolve('scripts/release/t2-image.mjs'), root, join(root, 'candidate'), '--include-platform'], {
      env: { ...process.env, CANDIDATE_SHA: commit, GITHUB_RUN_ID: '123' }, encoding: 'utf8',
    })
    expect(invoke().status).not.toBe(0)
    await writeFile(join(root, archive), bytes)
    await writeFile(join(root, 'dsh-phalanx-linux-amd64.tar.gz'), 'platform')
    const result = invoke()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ digest, archiveSha256: sha256(bytes) })
    expect(await readFile(join(root, 'candidate', archive), 'utf8')).toBe(bytes)
    expect(await readFile(join(root, 'candidate', 'dsh-phalanx-linux-amd64.tar.gz'), 'utf8')).toBe('platform')
  } finally { await rm(root, { recursive: true, force: true }) }
})

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
