import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { harnessReusePlan } from '../scripts/release/harness-reuse.mjs'
import { assetNames, imageName, sha256 } from '../scripts/release/integrity.mjs'

it('promotes an accepted snapshot from its exact candidate run, rejecting mismatches before publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-promotion-'))
  const source = 'b'.repeat(40),
    workflow = source,
    anchor = 'd'.repeat(40)
  const repository = 'dake6767/dsh-phalanx',
    candidates = `${repository}-candidates`,
    version = '0.1.24',
    runId = '123'
  const digest = `sha256:${'a'.repeat(64)}`
  try {
    // Promotion discovers stable version names from the checked-out repository's tags.
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
    }
    git('init', '--quiet')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '--allow-empty', '-m', 'fixture')
    git('tag', 'v0.1.23')
    git('tag', `v${version}-rc.1`)
    const directory = join(root, 'assets'),
      bin = join(root, 'bin'),
      records = join(root, 'releases/acceptance')
    await mkdir(directory)
    await mkdir(bin)
    await mkdir(records, { recursive: true })
    await mkdir(join(root, 'releases/notes'))
    await writeFile(join(root, `releases/notes/${version}.md`), `# ${version}\n\nFixture release notes.\n`)
    await writeFile(join(bin, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${resolve('tests/fixtures/promotion-gh.mjs')}' "$@"\n`, { mode: 0o755 })
    const manifest = {
      schema: 2,
      tag: `run-${runId}`,
      targetVersion: version,
      commit: source,
      platform: 'linux/amd64',
      runId,
      dshRevision: 'e'.repeat(40),
      toolchain: { node: '24.21.0', pnpm: '11.19.0' },
      image: { name: imageName, tag: `run-${runId}`, digest, reference: `${imageName}@${digest}` },
      files: Object.fromEntries(assetNames.map(name => [name, sha256(name)])),
      compatibility: {
        protocol: 3,
        source: { min: '0.1.23', maxExclusive: version },
        accounts: { sourceMin: 5, sourceMax: 5, target: 5 },
        environmentEpoch: 1,
      },
      acceptancePolicy: { ticket: 8, checks: ['ci', 'linux', 'upgrade', 'cleanInstall'] },
      storage: { platformArchiveBytes: 100, platformExpandedBytes: 200, imageDownloadBytes: 300, imageExpandedBytes: 400 },
      updater: '{}',
      updaterAsset: { name: 'updater.json', sha256: sha256('{}\n') },
    }
    await writeFile(join(directory, 'updater.json'), '{}\n')
    for (const name of assetNames) await writeFile(join(directory, name), name)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'SHA256SUMS'), assetNames.map(name => `${manifest.files[name]}  ${name}\n`).join(''))
    const summary = `Accepted.\n\nRun: ${runId}.\n\nImage digest: ${digest}.\n`
    const acceptance = {
      schema: 1,
      ticket: 8,
      status: 'accepted',
      candidate: manifest.tag,
      commit: source,
      runId,
      platformSha256: manifest.files[assetNames[0]!],
      imageDigest: digest,
      summarySha256: sha256(summary),
      checks: Object.fromEntries(manifest.acceptancePolicy.checks.map(name => [name, 'passed'])),
    }
    const acceptanceBytes = JSON.stringify(acceptance)
    await writeFile(join(records, `${version}.md`), summary)
    await writeFile(join(records, `${version}.json`), acceptanceBytes)
    const runPath = `repos/${repository}/actions/runs/${runId}`
    const run = {
      id: Number(runId),
      status: 'completed',
      conclusion: 'success',
      event: 'workflow_dispatch',
      path: '.github/workflows/candidate.yml',
      head_branch: `candidate/${version}`,
      head_sha: workflow,
    }
    const facts: Record<string, unknown> = {
      [`repos/${repository}`]: { default_branch: 'main', private: false },
      [`repos/${candidates}`]: { default_branch: 'main', private: false },
      [`repos/${repository}/git/ref/heads/candidate/${version}`]: { object: { type: 'commit', sha: workflow } },
      [runPath]: run,
      [`repos/${candidates}/releases/tags/${manifest.tag}`]: { tag_name: manifest.tag, draft: false, prerelease: true },
      [`repos/${candidates}/git/ref/tags/${manifest.tag}`]: { object: { type: 'commit', sha: anchor } },
      [`repos/${repository}/compare/${source}...${workflow}`]: { status: 'ahead' },
      [`repos/${repository}/contents/package.json?ref=${source}`]: { content: Buffer.from(JSON.stringify({ version })).toString('base64') },
    }
    await writeFile(join(root, 'identity.json'), JSON.stringify({ repository: candidates, tag: manifest.tag }))
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PROMOTION_FIXTURE_ROOT: root,
      GITHUB_REPOSITORY: repository,
      GITHUB_SHA: workflow,
      GITHUB_REF: `refs/heads/candidate/${version}`,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      CANDIDATE_RUN_ID: runId,
      PROMOTION_VERSION: version,
      ACCEPTANCE_SHA256: sha256(acceptanceBytes),
    }
    let attempt = 0
    const invoke = async (changes = {}, overrides = {}) => {
      await writeFile(join(root, 'responses.json'), JSON.stringify({ ...facts, ...overrides }))
      const output = join(root, `promoted-${attempt++}`)
      const result = spawnSync(process.execPath, [resolve('scripts/release/promotion.mjs'), output], {
        cwd: root,
        env: { ...env, ...changes },
        encoding: 'utf8',
      })
      return { result, output }
    }
    const { result, output } = await invoke()
    expect(result.status, result.stderr).toBe(0)
    const promoted = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'))
    expect(promoted.releaseNotes).toContain('Fixture release notes.')
    expect(promoted.versions).toEqual(['v0.1.23', `v${version}`])
    expect(promoted).toMatchObject({
      candidate: 'run-123',
      candidateRun: runId,
      commit: source,
      imageDigest: digest,
      acceptanceSha256: sha256(acceptanceBytes),
    })
    expect(await readFile(join(output, assetNames[0]!))).toEqual(await readFile(join(directory, assetNames[0]!)))
    const harnessHead = 'e'.repeat(40)
    const beforeTree = { truncated: false, tree: [{ path: 'tests/example.spec.ts', mode: '100644', type: 'blob', sha: 'a'.repeat(40) }] }
    const afterTree = { truncated: false, tree: [{ path: 'tests/example.spec.ts', mode: '100644', type: 'blob', sha: 'f'.repeat(40) }] }
    const reuseFacts = {
      [`repos/${repository}/git/ref/heads/candidate/${version}`]: { object: { type: 'commit', sha: harnessHead } },
      [`repos/${repository}/git/trees/${source}?recursive=1`]: beforeTree,
      [`repos/${repository}/git/trees/${harnessHead}?recursive=1`]: afterTree,
    }
    expect((await invoke({ GITHUB_SHA: harnessHead }, reuseFacts)).result.status).not.toBe(0)
    const reuse = JSON.stringify({
      ...acceptance,
      harnessReuse: { builtSource: source, inputDigest: harnessReusePlan(beforeTree, afterTree).inputDigest, reruns: { ci: 'passed' } },
    })
    await writeFile(join(records, `${version}.json`), reuse)
    expect((await invoke({ GITHUB_SHA: harnessHead, ACCEPTANCE_SHA256: sha256(reuse) }, reuseFacts)).result.status).toBe(0)
    const installerTree = {
      truncated: false,
      tree: [...afterTree.tree, { path: 'tests/installer-ubuntu.e2e.ts', mode: '100644', type: 'blob', sha: 'e'.repeat(40) }],
    }
    const installerFacts = { ...reuseFacts, [`repos/${repository}/git/trees/${harnessHead}?recursive=1`]: installerTree }
    const missingClean = JSON.stringify({
      ...acceptance,
      harnessReuse: { builtSource: source, inputDigest: harnessReusePlan(beforeTree, installerTree).inputDigest, reruns: { ci: 'passed', linux: 'passed' } },
    })
    await writeFile(join(records, `${version}.json`), missingClean)
    expect((await invoke({ GITHUB_SHA: harnessHead, ACCEPTANCE_SHA256: sha256(missingClean) }, installerFacts)).result.status).not.toBe(0)
    const cleanRerun = JSON.stringify({
      ...acceptance,
      harnessReuse: {
        builtSource: source,
        inputDigest: harnessReusePlan(beforeTree, installerTree).inputDigest,
        reruns: { ci: 'passed', linux: 'passed', cleanInstall: 'passed' },
      },
    })
    await writeFile(join(records, `${version}.json`), cleanRerun)
    expect((await invoke({ GITHUB_SHA: harnessHead, ACCEPTANCE_SHA256: sha256(cleanRerun) }, installerFacts)).result.status).toBe(0)
    await writeFile(join(records, `${version}.json`), reuse)
    expect(
      (
        await invoke(
          { GITHUB_SHA: harnessHead, ACCEPTANCE_SHA256: sha256(reuse) },
          {
            ...reuseFacts,
            [`repos/${repository}/git/trees/${harnessHead}?recursive=1`]: {
              truncated: false,
              tree: [...afterTree.tree, { path: 'src/product.ts', mode: '100644', type: 'blob', sha: 'f'.repeat(40) }],
            },
          },
        )
      ).result.status,
    ).not.toBe(0)
    await writeFile(join(records, `${version}.json`), acceptanceBytes)
    for (const invalid of [
      { CANDIDATE_RUN_ID: '0' },
      { ACCEPTANCE_SHA256: 'f'.repeat(64) },
      { PROMOTION_VERSION: '0.1.25' },
      { GITHUB_REF: 'refs/heads/topic' },
    ]) {
      expect((await invoke(invalid)).result.status).not.toBe(0)
    }
    for (const invalid of [{ conclusion: 'failure' }, { event: 'push' }, { head_branch: 'run-123' }, { path: '.github/workflows/other.yml' }, { id: 124 }]) {
      expect((await invoke({}, { [runPath]: { ...run, ...invalid } })).result.status).not.toBe(0)
    }
    expect(
      (await invoke({}, { [`repos/${repository}/git/ref/heads/candidate/${version}`]: { object: { type: 'commit', sha: 'f'.repeat(40) } } })).result.status,
    ).not.toBe(0)
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        imageIdentity: { inputHash: 'f'.repeat(64), dshRevision: manifest.dshRevision, digest, buildCommit: source },
        imageSelection: {
          mode: 'build',
          reason: 'forced',
          rehearsal: true,
          inputHash: 'f'.repeat(64),
          dshRevision: manifest.dshRevision,
          platform: manifest.platform,
        },
      }),
    )
    const reuseRehearsal = (await invoke()).result
    expect(reuseRehearsal.status).not.toBe(0)
    expect(reuseRehearsal.stderr).toContain('rehearsal')
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(directory, assetNames[0]!), 'tampered bytes')
    expect((await invoke()).result.status).not.toBe(0)
    await writeFile(join(directory, assetNames[0]!), assetNames[0]!)
    const incomplete = JSON.stringify({ ...acceptance, checks: { ...acceptance.checks, linux: 'pending' } })
    await writeFile(join(records, `${version}.json`), incomplete)
    expect((await invoke({ ACCEPTANCE_SHA256: sha256(incomplete) })).result.status).not.toBe(0)
    const calls = await readFile(join(root, 'calls.jsonl'), 'utf8')
    expect(calls).not.toMatch(/"(?:POST|PATCH|DELETE|create|upload|edit)"/u)
    // The rehearsal does not turn this incomplete formal acceptance into a pass.
    const testTag = 'v0.1.24-rehearsal.123',
      trialDirectory = join(root, 'rehearsal')
    await writeFile(join(bin, 'curl'), `#!/bin/sh\nexec '${process.execPath}' '${resolve('tests/fixtures/promotion-gh.mjs')}' --curl "$@"\n`, { mode: 0o755 })
    const trial = (mode: string) =>
      spawnSync(process.execPath, [resolve('scripts/release/rehearsal.mjs'), mode, trialDirectory], {
        cwd: root,
        env: { ...env, PROMOTION_VERSION: undefined, PROMOTION_REHEARSAL: 'true', GITHUB_WORKFLOW: 'Candidate rehearsal', REHEARSAL_FIXTURE_TAG: testTag },
        encoding: 'utf8',
      })
    const prepared = trial('prepare')
    expect(prepared.status, prepared.stderr).toBe(0)
    const proof = JSON.parse(await readFile(join(trialDirectory, 'rehearsal.json'), 'utf8'))
    expect(proof).toMatchObject({ acceptance: 'not-accepted', purpose: 'publication-rehearsal', candidate: 'run-123', testVersion: '0.1.24-rehearsal.123' })
    const downloads = join(root, 'rehearsal-downloads')
    await mkdir(downloads)
    for (const name of ['manifest.json', 'SHA256SUMS', 'rehearsal.json', 'updater.json', ...assetNames])
      await copyFile(join(trialDirectory, name), join(downloads, name))
    const verified = trial('verify')
    expect(verified.status, verified.stderr).toBe(0)
    expect(JSON.parse(await readFile(join(trialDirectory, 'rehearsal-verification.json'), 'utf8'))).toMatchObject({
      result: 'passed',
      mainRepositoryMutated: false,
      imageDigest: digest,
    })
    await writeFile(join(downloads, assetNames[0]!), 'corrupt anonymous download')
    expect(trial('verify').status).not.toBe(0)
    await copyFile(join(trialDirectory, assetNames[0]!), join(downloads, assetNames[0]!))
    await writeFile(
      join(root, 'responses.json'),
      JSON.stringify({ ...facts, [`repos/${candidates}/releases?per_page=100`]: [[{ tag_name: testTag, draft: false, prerelease: true }]] }),
    )
    await writeFile(join(downloads, 'rehearsal.json'), '{}')
    await writeFile(join(root, 'calls.jsonl'), '')
    expect(trial('cleanup').status).not.toBe(0)
    expect(await readFile(join(root, 'calls.jsonl'), 'utf8')).not.toContain('"delete"')
    await copyFile(join(trialDirectory, 'rehearsal.json'), join(downloads, 'rehearsal.json'))
    const cleaned = trial('cleanup')
    expect(cleaned.status, cleaned.stderr).toBe(0)
    expect(JSON.parse(await readFile(join(trialDirectory, 'rehearsal-cleanup.json'), 'utf8'))).toMatchObject({
      tag: testTag,
      deleted: true,
      candidateRetained: 'run-123',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
