import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { assetNames, imageName, sha256 } from '../scripts/release/integrity.mjs'

it.each(['0.1.0', '0.1.1', '0.1.4'])('publishes and promotes the exact image digest without overwriting tags for %s', async version => {
  const root = await mkdtemp(join(tmpdir(), 'image-publication-'))
  try {
    const directory = join(root, 'assets'),
      bin = join(root, 'bin')
    await mkdir(directory)
    await mkdir(bin)
    const fixture = resolve('tests/fixtures/release-registry.mjs')
    await writeFile(join(bin, 'skopeo'), `#!/bin/sh\nexec '${process.execPath}' '${fixture}' --copy "$@"\n`, { mode: 0o755 })
    const digest = `sha256:${'a'.repeat(64)}`,
      commit = 'b'.repeat(40)
    const manifest = {
      schema: version === '0.1.4' ? 2 : 1,
      ...(version === '0.1.4'
        ? {
            compatibility: {
              protocol: 1,
              source: { min: '0.1.1', maxExclusive: '0.2.0' },
              accounts: { sourceMin: 4, sourceMax: 4, target: 4 },
              environmentEpoch: 1,
            },
            acceptancePolicy: { ticket: 6, checks: ['ci', 'linux', 'cleanInstall', 'upgrade', 'review'] },
          }
        : {}),
      tag: `v${version}-rc.1`,
      targetVersion: version,
      commit,
      platform: 'linux/amd64',
      runId: '123',
      dshRevision: 'c'.repeat(40),
      toolchain: { node: '24.21.0', pnpm: '11.19.0' },
      image: { name: imageName, tag: `${version}-rc.1`, digest, reference: `${imageName}@${digest}` },
      files: Object.fromEntries(assetNames.map(name => [name, sha256(name)])),
    }
    for (const name of assetNames) await writeFile(join(directory, name), name)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'SHA256SUMS'), assetNames.map(name => `${manifest.files[name]}  ${name}\n`).join(''))
    const path = join(root, 'registry.json')
    await writeFile(path, JSON.stringify({ digest, tags: {}, copies: 0, anonymousReads: 0 }))
    const state = async () =>
      JSON.parse(await readFile(path, 'utf8')) as { digest: string; tags: Record<string, string>; copies: number; anonymousReads: number }
    const invoke = (promotion?: string) =>
      spawnSync(process.execPath, ['--import', fixture, 'scripts/release/publish-image.mjs', directory], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RELEASE_FIXTURE_ROOT: root,
          CANDIDATE_TAG: manifest.tag,
          CANDIDATE_SHA: commit,
          GITHUB_ACTOR: 'fixture',
          GH_TOKEN: 'fictional-job-token',
          PROMOTION_VERSION: promotion,
        },
      })
    expect(invoke().status).toBe(0)
    expect(invoke().status).toBe(0)
    expect((await state()).copies).toBe(1)
    expect(invoke(version).status).toBe(0)
    expect((await state()).tags[version]).toBe(digest)
    expect((await state()).anonymousReads).toBeGreaterThan(0)
    expect(invoke(version === '0.1.0' ? '0.1.1' : '0.1.0').status).not.toBe(0)
    const conflict = await state()
    conflict.tags[manifest.image.tag] = `sha256:${'f'.repeat(64)}`
    await writeFile(path, JSON.stringify(conflict))
    expect(invoke().status).not.toBe(0)
    expect((await state()).copies).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['0.1.0', '0.1.1', '0.1.4'])(
  'recovers a partial draft, rejects changed bytes, retries complete candidates and promotes unchanged assets in an isolated sample for %s',
  async version => {
    const root = await mkdtemp(join(tmpdir(), 'release-publication-'))
    try {
      const directory = join(root, 'assets'),
        bin = join(root, 'bin')
      await mkdir(directory)
      await mkdir(bin)
      await writeFile(join(bin, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${resolve('tests/fixtures/release-gh.mjs')}' "$@"\n`, { mode: 0o755 })
      const digest = `sha256:${'a'.repeat(64)}`,
        commit = 'b'.repeat(40)
      const manifest = {
        schema: version === '0.1.4' ? 2 : 1,
        ...(version === '0.1.4'
          ? {
              compatibility: {
                protocol: 1,
                source: { min: '0.1.1', maxExclusive: '0.2.0' },
                accounts: { sourceMin: 4, sourceMax: 4, target: 4 },
                environmentEpoch: 1,
              },
              acceptancePolicy: { ticket: 6, checks: ['ci', 'linux', 'cleanInstall', 'upgrade', 'review'] },
            }
          : {}),
        tag: `v${version}-rc.1`,
        targetVersion: version,
        commit,
        platform: 'linux/amd64',
        runId: '123',
        dshRevision: 'c'.repeat(40),
        toolchain: { node: '24.21.0', pnpm: '11.19.0' },
        image: { name: imageName, tag: `${version}-rc.1`, digest, reference: `${imageName}@${digest}` },
        files: Object.fromEntries(assetNames.map(name => [name, sha256(name)])),
      }
      for (const name of assetNames) await writeFile(join(directory, name), name)
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
      await writeFile(join(directory, 'SHA256SUMS'), assetNames.map(name => `${manifest.files[name]}  ${name}\n`).join(''))
      await writeFile(
        join(root, 'state.json'),
        JSON.stringify({ refs: [{ ref: `refs/tags/${manifest.tag}`, object: { type: 'commit', sha: commit } }], releases: [] }),
      )
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RELEASE_FIXTURE_ROOT: root,
        GITHUB_REPOSITORY: 'fixture/sample',
        CANDIDATE_TAG: manifest.tag,
        CANDIDATE_SHA: commit,
      }
      const invoke = (changes = {}) =>
        spawnSync(process.execPath, ['scripts/release/publish-release.mjs', directory], { env: { ...env, ...changes }, encoding: 'utf8' })
      const state = async () =>
        JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as {
          refs: { ref: string; object: { sha: string } }[]
          releases: { draft: boolean; body: string; latest?: boolean; assets: { name: string }[] }[]
        }
      expect(invoke({ RELEASE_FIXTURE_FAIL_ASSET: 'SHA256SUMS', RELEASE_FIXTURE_STALE_LIST: 'true' }).status).not.toBe(0)
      expect((await state()).releases[0]!.draft).toBe(true)
      expect((await state()).releases[0]!.assets).toHaveLength(2)
      expect(invoke().status).toBe(0)
      expect((await state()).releases[0]!.draft).toBe(false)
      expect((await state()).releases[0]!.latest).toBe(false)
      expect((await state()).releases[0]!.body).toBe('Private preview candidate. Verify SHA256SUMS and manifest before installation.')
      expect(invoke().status).toBe(0)
      const initial = await readFile(join(directory, assetNames[0]!))
      await writeFile(join(root, manifest.tag, assetNames[0]!), 'conflicting uploaded bytes')
      expect(invoke().status).not.toBe(0)
      await writeFile(join(root, manifest.tag, assetNames[0]!), initial)
      for (const name of ['acceptance.json', 'acceptance.md', 'release.json']) await writeFile(join(directory, name), 'isolated sample only')
      for (const invalid of [undefined, '', '# 9.9.9\n\nWrong release']) {
        if (invalid !== undefined) await writeFile(join(root, 'notes.md'), invalid)
        expect(invoke({ PROMOTION_VERSION: version }).status).not.toBe(0)
        expect((await state()).releases[1]!.draft).toBe(true)
      }
      const notes = `# ${version}\n\n## English\n\nRead [install](../../docs/install.md#skills). [angle](<../../docs/install.md>) [external](<https://example.com/guide>)\n\n## 简体中文\n\n阅读[安装](../../docs/install.zh-CN.md#技能)。\n`
      await writeFile(join(root, 'notes.md'), notes)
      expect(invoke({ PROMOTION_VERSION: version }).status).toBe(0)
      expect((await state()).releases[1]!.body).toContain(`https://github.com/fixture/sample/blob/v${version}/docs/install.md#skills`)
      expect((await state()).releases[1]!.body).toContain('## 简体中文')
      expect((await state()).releases[1]!.body).toContain(`[angle](<https://github.com/fixture/sample/blob/v${version}/docs/install.md>)`)
      expect((await state()).releases[1]!.body).toContain('[external](<https://example.com/guide>)')
      expect((await state()).releases[1]!.body).toMatch(/本发布由已验收候选直接提升，未重新构建；校验见 release\.json、acceptance\.md。\n$/u)
      expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(notes)
      expect((await state()).refs.find(item => item.ref === `refs/tags/v${version}`)?.object.sha).toBe(commit)
      expect((await state()).releases[1]!.draft).toBe(false)
      expect((await state()).releases[1]!.latest).toBe(true)
      expect(await readFile(join(root, `v${version}`, assetNames[0]!))).toEqual(initial)
      await writeFile(join(root, 'notes.md'), '# 9.9.9\n\nChanged after publication')
      const published = (await state()).releases[1]!.body
      expect(invoke({ PROMOTION_VERSION: version }).status).toBe(0)
      expect((await state()).releases[1]!.body).toBe(published)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('publishes a run candidate into the candidate repository using its own metadata anchor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-candidate-publication-'))
  try {
    const directory = join(root, 'assets'),
      bin = join(root, 'bin')
    await mkdir(directory)
    await mkdir(bin)
    await writeFile(join(bin, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${resolve('tests/fixtures/release-gh.mjs')}' "$@"\n`, { mode: 0o755 })
    const digest = `sha256:${'a'.repeat(64)}`,
      commit = 'b'.repeat(40),
      anchor = 'd'.repeat(40)
    const manifest = {
      schema: 2,
      tag: 'run-123',
      targetVersion: '0.1.16',
      commit,
      platform: 'linux/amd64',
      runId: '123',
      dshRevision: 'c'.repeat(40),
      toolchain: { node: '24.21.0', pnpm: '11.19.0' },
      image: { name: imageName, tag: 'run-123', digest, reference: `${imageName}@${digest}` },
      files: Object.fromEntries(assetNames.map(name => [name, sha256(name)])),
      compatibility: {
        protocol: 3,
        source: { min: '0.1.13', maxExclusive: '0.1.16' },
        accounts: { sourceMin: 5, sourceMax: 5, target: 5 },
        environmentEpoch: 1,
      },
      acceptancePolicy: { ticket: 8, checks: ['ci', 'linux', 'cleanInstall', 'upgrade', 'review'] },
      storage: { platformArchiveBytes: 100, platformExpandedBytes: 200, imageDownloadBytes: 300, imageExpandedBytes: 400 },
      updater: '{}',
      updaterAsset: { name: 'updater.json', sha256: sha256('{}\n') },
    }
    await writeFile(join(directory, 'updater.json'), '{}\n')
    for (const name of assetNames) await writeFile(join(directory, name), name)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'SHA256SUMS'), assetNames.map(name => `${manifest.files[name]}  ${name}\n`).join(''))
    await writeFile(join(root, 'state.json'), JSON.stringify({ refs: [], releases: [], anchor }))
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RELEASE_FIXTURE_ROOT: root,
      GITHUB_REPOSITORY: 'dake6767/dsh-phalanx',
      GITHUB_RUN_ID: '123',
      GITHUB_SHA: commit,
      GITHUB_REF: 'refs/heads/candidate/0.1.16',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      CANDIDATE_TAG: 'run-123',
      CANDIDATE_SHA: commit,
    }
    const invoke = (changes = {}) =>
      spawnSync(process.execPath, ['scripts/release/publish-release.mjs', directory], { env: { ...env, ...changes }, encoding: 'utf8' })
    for (const invalid of [{ CANDIDATE_TAG: 'run-124' }, { GITHUB_RUN_ID: '124' }, { CANDIDATE_SHA: undefined }]) {
      expect(invoke(invalid).status).not.toBe(0)
    }
    expect(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')).refs).toEqual([])
    const result = invoke()
    expect(result.status, result.stderr).toBe(0)
    const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as {
      refs: { ref: string; object: { sha: string }; repository: string }[]
      releases: { name: string; body: string; draft: boolean; repository: string }[]
    }
    expect(state.refs).toEqual([{ ref: 'refs/tags/run-123', object: { type: 'commit', sha: anchor }, repository: 'dake6767/dsh-phalanx-candidates' }])
    expect(state.releases[0]).toMatchObject({ name: '123', draft: false, repository: 'dake6767/dsh-phalanx-candidates' })
    expect(state.releases[0]!.body).toContain(digest)
    expect(await readFile(join(root, 'run-123/updater.json'), 'utf8')).toBe('{}\n')
    expect(JSON.parse(await readFile(join(root, 'run-123/candidate.json'), 'utf8'))).toMatchObject({
      schema: 1,
      candidate: manifest.tag,
      commit,
      runId: '123',
      targetVersion: '0.1.16',
      manifestSha256: sha256(await readFile(join(directory, 'manifest.json'))),
      workflow: { path: '.github/workflows/candidate.yml', commit, ref: 'refs/heads/candidate/0.1.16' },
    })
    expect(invoke().status).toBe(0)
    const advanced = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
    advanced.anchor = 'e'.repeat(40)
    await writeFile(join(root, 'state.json'), JSON.stringify(advanced))
    expect(invoke().status).toBe(0)
    const rehearsal = {
      purpose: 'publication-rehearsal',
      acceptance: 'not-accepted',
      candidate: manifest.tag,
      runId: manifest.runId,
      commit,
      testVersion: '0.1.16-rehearsal.123',
      manifestSha256: sha256(await readFile(join(directory, 'manifest.json'))),
    }
    await writeFile(join(directory, 'rehearsal.json'), JSON.stringify(rehearsal))
    const rehearsalEnv = {
      PROMOTION_REHEARSAL: 'true',
      CANDIDATE_RUN_ID: '123',
      GITHUB_RUN_ID: '999',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/candidate/0.1.16',
      GITHUB_WORKFLOW: 'Candidate rehearsal',
    }
    const trial = invoke(rehearsalEnv)
    expect(trial.status, trial.stderr).toBe(0)
    const trialState = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
    expect(trialState.refs[1]).toMatchObject({
      ref: 'refs/tags/v0.1.16-rehearsal.123',
      repository: 'dake6767/dsh-phalanx-candidates',
      object: { sha: 'e'.repeat(40) },
    })
    expect(trialState.releases[1]).toMatchObject({ prerelease: true, latest: false, repository: 'dake6767/dsh-phalanx-candidates', draft: false })
    expect(trialState.releases[1].assets.map((asset: { name: string }) => asset.name)).toContain('rehearsal.json')
    expect(trialState.releases[1].assets.map((asset: { name: string }) => asset.name)).not.toContain('acceptance.json')
    expect(await readFile(join(root, 'v0.1.16-rehearsal.123', assetNames[0]!))).toEqual(await readFile(join(directory, assetNames[0]!)))
    for (const invalid of [{ GITHUB_REF: 'refs/heads/topic' }, { GITHUB_WORKFLOW: 'Release' }, { CANDIDATE_RUN_ID: '124' }, { PROMOTION_VERSION: '0.1.16' }]) {
      expect(invoke({ ...rehearsalEnv, ...invalid }).status).not.toBe(0)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('publishes a formal snapshot by fast-forwarding main before the tag and deletes the candidate only after completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'formal-snapshot-publication-'))
  try {
    const source = join(root, 'source'),
      remote = join(root, 'public.git'),
      bin = join(root, 'bin'),
      directory = join(root, 'assets')
    await mkdir(source)
    await mkdir(bin)
    await mkdir(directory)
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
    const stable = git('rev-parse', 'HEAD')
    git('switch', '-c', 'candidate/0.1.24')
    git('commit', '--allow-empty', '-qm', 'Release 0.1.24')
    const commit = git('rev-parse', 'HEAD')
    git('push', 'origin', 'candidate/0.1.24')
    await writeFile(join(bin, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${resolve('tests/fixtures/release-gh.mjs')}' "$@"\n`, { mode: 0o755 })
    const digest = `sha256:${'a'.repeat(64)}`
    const manifest = {
      schema: 2,
      tag: 'run-123',
      targetVersion: '0.1.24',
      commit,
      platform: 'linux/amd64',
      runId: '123',
      dshRevision: 'c'.repeat(40),
      toolchain: { node: '24.21.0', pnpm: '11.19.0' },
      image: { name: imageName, tag: 'run-123', digest, reference: `${imageName}@${digest}` },
      files: Object.fromEntries(assetNames.map(name => [name, sha256(name)])),
      compatibility: {
        protocol: 3,
        source: { min: '0.1.23', maxExclusive: '0.1.24' },
        accounts: { sourceMin: 5, sourceMax: 5, target: 5 },
        environmentEpoch: 1,
      },
      acceptancePolicy: { ticket: 8, checks: ['ci', 'linux', 'upgrade'] },
      storage: { platformArchiveBytes: 1, platformExpandedBytes: 1, imageDownloadBytes: 1, imageExpandedBytes: 1 },
      updater: '{}',
    }
    for (const name of assetNames) await writeFile(join(directory, name), name)
    for (const name of ['acceptance.json', 'acceptance.md', 'release.json']) await writeFile(join(directory, name), 'already validated promotion artifact')
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'SHA256SUMS'), assetNames.map(name => `${manifest.files[name]}  ${name}\n`).join(''))
    await writeFile(join(root, 'notes.md'), '# 0.1.24\n\nMember improvements.\n')
    const invoke = (changes = {}) =>
      spawnSync(process.execPath, [resolve('scripts/release/publish-release.mjs'), directory], {
        cwd: source,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RELEASE_FIXTURE_ROOT: root,
          PUBLIC_SOURCE_FIXTURE_REMOTE: remote,
          GITHUB_REPOSITORY: 'dake6767/dsh-phalanx',
          GITHUB_REF: 'refs/heads/candidate/0.1.24',
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_SHA: commit,
          CANDIDATE_TAG: 'run-123',
          CANDIDATE_SHA: commit,
          PROMOTION_VERSION: '0.1.24',
          ...changes,
        },
      })
    await writeFile(join(root, 'state.json'), JSON.stringify({ refs: [{ ref: 'refs/tags/v0.1.24', object: { type: 'commit', sha: stable } }], releases: [] }))
    expect(invoke().status).not.toBe(0)
    expect(git('ls-remote', 'origin', 'refs/heads/main')).toBe(`${stable}\trefs/heads/main`)
    await writeFile(join(root, 'state.json'), JSON.stringify({ refs: [], releases: [] }))
    expect(invoke({ RELEASE_FIXTURE_FAIL_ASSET: 'SHA256SUMS' }).status).not.toBe(0)
    expect(git('ls-remote', 'origin', 'refs/heads/main')).toBe(`${commit}\trefs/heads/main`)
    expect(git('ls-remote', 'origin', 'refs/heads/candidate/0.1.24')).toContain(commit)
    expect(git('ls-remote', 'origin', 'refs/tags/v0.1.24')).toBe(`${commit}\trefs/tags/v0.1.24`)
    const result = invoke()
    expect(result.status, result.stderr).toBe(0)
    expect(git('ls-remote', 'origin', 'refs/heads/candidate/0.1.24')).toBe('')
    const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
    expect(state.releases[0]).toMatchObject({ draft: false, latest: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
