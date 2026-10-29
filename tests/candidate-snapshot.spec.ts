import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'

it('pushes one release-notes snapshot over public main and replaces only the candidate with an exact lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-snapshot-'))
  try {
    const source = join(root, 'source'),
      remote = join(root, 'public.git'),
      state = join(root, 'state')
    await mkdir(source)
    await mkdir(join(state, 'local-check'), { recursive: true })
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' })
      if (result.status !== 0) throw Error(result.stderr)
      return result.stdout.trim()
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    await writeFile(join(source, 'package.json'), JSON.stringify({ version: '0.1.24' }))
    await writeFile(join(source, 'release-policy.json'), JSON.stringify({ acceptancePolicy: { checks: ['ci', 'linux', 'upgrade'] } }))
    git('add', '.')
    git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')
    git('init', '--bare', '-q', remote)
    git('remote', 'add', 'public', remote)
    git('push', 'public', 'main')
    git('switch', '-c', 'release/0.1.24')
    await mkdir(join(source, 'releases/notes'), { recursive: true })
    await writeFile(join(source, 'releases/notes/0.1.24.md'), '# 0.1.24\n\nMember improvements.\n')
    await writeFile(join(source, 'feature.txt'), 'delivered feature')
    git('add', '.')
    git('commit', '-qm', 'private ticket implementation')
    const invoke = () =>
      spawnSync(process.execPath, [resolve('scripts/release/snapshot.mjs')], {
        cwd: source,
        env: { ...process.env, DSH_PHALANX_VALIDATION_STATE_ROOT: state },
        encoding: 'utf8',
      })
    expect(invoke().status).not.toBe(0) // No successful local check record.
    const record = async () => {
      const head = git('rev-parse', 'HEAD')
      await writeFile(
        join(state, `local-check/${head}.json`),
        JSON.stringify({
          protocol: 'local-check-v1',
          commit: head,
          status: 'passed',
          clean: true,
          stages: ['fast-check', 'documentation', 'browser'].map(name => ({ name, status: 'passed' })),
        }),
      )
    }
    await mkdir(join(state, 'fast-check'), { recursive: true })
    const unchecked = git('rev-parse', 'HEAD')
    await writeFile(join(state, `fast-check/${unchecked}.json`), JSON.stringify({ commit: unchecked, clean: true, status: 'passed' }))
    expect(invoke().status).not.toBe(0) // The original fast check alone cannot authorize a snapshot.
    await record()
    const first = invoke()
    expect(first.status, first.stderr).toBe(0)
    const snapshot = first.stdout.trim()
    expect(git('rev-parse', `${snapshot}^`)).toBe(base)
    expect(git('rev-parse', `${snapshot}^{tree}`)).toBe(git('rev-parse', 'HEAD^{tree}'))
    expect(git('show', '-s', '--format=%B', snapshot)).toBe('Release 0.1.24\n\n# 0.1.24\n\nMember improvements.')
    expect(git('rev-list', '--count', `${base}..${snapshot}`)).toBe('1')
    await writeFile(join(source, 'feature.txt'), 'corrected feature')
    expect(invoke().status).not.toBe(0) // Dirty release tree.
    git('add', '.')
    git('commit', '-qm', 'fix')
    await record()
    const second = invoke()
    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout.trim()).not.toBe(snapshot)
    expect(git('rev-list', '--count', `${base}..${second.stdout.trim()}`)).toBe('1')
    expect(git('ls-remote', 'public', 'refs/heads/main')).toBe(`${base}\trefs/heads/main`)
    expect(git('ls-remote', 'public', 'refs/heads/candidate/0.1.24')).toBe(`${second.stdout.trim()}\trefs/heads/candidate/0.1.24`)
    await writeFile(join(source, 'install.sh'), '#!/bin/sh\nexit 0\n')
    git('add', '.')
    git('commit', '-qm', 'installer change')
    await record()
    expect(invoke().status).not.toBe(0)
    await writeFile(join(source, 'release-policy.json'), JSON.stringify({ acceptancePolicy: { checks: ['ci', 'linux', 'upgrade', 'cleanInstall'] } }))
    git('add', '.')
    git('commit', '-qm', 'declare installer acceptance')
    await record()
    expect(invoke().status).toBe(0)
    git('switch', 'main')
    expect(invoke().status).not.toBe(0)
    expect(await readFile(join(source, 'package.json'), 'utf8')).toContain('0.1.24')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('fast-forwards the exact single snapshot, resumes publication, and deletes only the unchanged candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-publish-'))
  try {
    const source = join(root, 'source'),
      remote = join(root, 'public.git')
    await mkdir(source)
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' })
      if (result.status !== 0) throw Error(result.stderr)
      return result.stdout.trim()
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    git('commit', '--allow-empty', '-qm', 'stable')
    git('init', '--bare', '-q', remote)
    git('remote', 'add', 'origin', remote)
    git('push', 'origin', 'main')
    git('switch', '-c', 'candidate/0.1.24')
    git('commit', '--allow-empty', '-qm', 'Release 0.1.24')
    const snapshot = git('rev-parse', 'HEAD')
    git('push', 'origin', 'candidate/0.1.24')
    const module = new URL(`file://${resolve('scripts/release/public-source.mjs')}`).href
    const invoke = (fn: string, sha = snapshot) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', `import { ${fn} } from ${JSON.stringify(module)}; ${fn}('0.1.24', '${sha}')`], {
        cwd: source,
        encoding: 'utf8',
      })
    const result = invoke('advanceSnapshot')
    expect(result.status, result.stderr).toBe(0)
    expect(invoke('advanceSnapshot').status).toBe(0)
    expect(git('ls-remote', 'origin', 'refs/heads/main')).toBe(`${snapshot}\trefs/heads/main`)
    git('tag', 'v0.1.24', snapshot)
    git('push', 'origin', 'v0.1.24')
    git('commit', '--allow-empty', '-qm', 'a newer unpublished candidate')
    git('push', 'origin', 'candidate/0.1.24')
    expect(invoke('removePublishedSnapshot').status).not.toBe(0)
    git('push', '--force', 'origin', `${snapshot}:refs/heads/candidate/0.1.24`)
    expect(invoke('removePublishedSnapshot').status).toBe(0)
    expect(git('ls-remote', 'origin', 'refs/heads/candidate/0.1.24')).toBe('')
    expect(git('ls-remote', 'origin', 'refs/tags/v0.1.24')).toBe(`${snapshot}\trefs/tags/v0.1.24`)
    expect(invoke('advanceSnapshot').status).not.toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
