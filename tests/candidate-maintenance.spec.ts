import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { assetNames, imageName, sha256 } from '../scripts/release/integrity.mjs'

it('dispatches exact remotely accepted promotion and cleans only completed candidates of the formally released version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-maintenance-'))
  try {
    const bin = join(root, 'bin'); await mkdir(bin)
    await writeFile(join(bin, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${resolve('tests/fixtures/release-maintenance-gh.mjs')}' "$@"\n`, { mode: 0o755 })
    const repository = 'dake6767/dsh-phalanx', candidates = `${repository}-candidates`, version = '0.1.16'
    const manifest = { schema: 2, tag: 'run-123', targetVersion: version, commit: 'b'.repeat(40), platform: 'linux/amd64', runId: '123',
      dshRevision: 'c'.repeat(40), toolchain: { node: '24.21.0', pnpm: '11.19.0' },
      image: { name: imageName, tag: 'run-123', digest: `sha256:${'a'.repeat(64)}`, reference: `${imageName}@sha256:${'a'.repeat(64)}` },
      files: Object.fromEntries(assetNames.map(name => [name, sha256(name)])),
      compatibility: { protocol: 3, source: { min: '0.1.13', maxExclusive: version }, accounts: { sourceMin: 5, sourceMax: 5, target: 5 }, environmentEpoch: 1 },
      acceptancePolicy: { ticket: 8, checks: ['ci', 'linux', 'cleanInstall', 'upgrade', 'review'] },
      storage: { platformArchiveBytes: 100, platformExpandedBytes: 200, imageDownloadBytes: 300, imageExpandedBytes: 400 }, updater: '{}' }
    for (const [tag, targetVersion] of [['v0.1.16', version], ['v0.1.15', '0.1.15'], ['run-123', version], ['run-124', version], ['run-125', '0.1.17'], ['run-127', version], ['run-128', version], ['run-129', version], ['run-130', version]]) {
      await mkdir(join(root, tag!))
      const identity = tag!.startsWith('run-') ? tag! : manifest.tag
      const letter = ({ 'run-124': 'e', 'v0.1.15': 'f', 'run-127': 'f', 'run-128': '1', 'run-129': '2', 'run-130': '3', 'run-125': '3' } as Record<string, string>)[tag!] ?? 'a'
      const digest = `sha256:${letter.repeat(64)}`
      await writeFile(join(root, tag!, 'manifest.json'), JSON.stringify({ ...manifest, targetVersion, tag: identity, runId: identity.slice(4), image: { ...manifest.image, tag: identity, digest, reference: `${imageName}@${digest}` }, imageIdentity: { inputHash: 'd'.repeat(64), dshRevision: manifest.dshRevision, digest, buildCommit: manifest.commit } }))
    }
    const summary = 'Accepted fixture summary'
    const acceptance = { schema: 1, ticket: 8, status: 'accepted', candidate: manifest.tag, commit: manifest.commit, runId: manifest.runId,
      platformSha256: manifest.files[assetNames[0]!], imageDigest: manifest.image.digest, summarySha256: sha256(summary),
      checks: Object.fromEntries(manifest.acceptancePolicy.checks.map(name => [name, 'passed'])) }
    const acceptanceBytes = JSON.stringify(acceptance), formalPath = `repos/${repository}/releases/tags/v${version}`
    const facts: Record<string, unknown> = {
      [`repos/${repository}`]: { default_branch: 'main' },
      [`repos/${repository}/contents/releases/acceptance/${version}.json?ref=main`]: { content: Buffer.from(acceptanceBytes).toString('base64') },
      [`repos/${repository}/contents/releases/acceptance/${version}.md?ref=main`]: { content: Buffer.from(summary).toString('base64') },
      [`repos/${repository}/releases?per_page=100`]: [[{ tag_name: 'v0.1.16', draft: false, prerelease: false }, { tag_name: 'v0.1.15', draft: false, prerelease: false }]],
      ['users/dake6767/packages/container/dsh-phalanx/versions?per_page=100']: [[
        ...[['a', ['run-123', version]], ['e', ['run-124', `input-${'d'.repeat(64)}`]], ['f', ['run-127']],
          ['1', ['run-128', 'run-126']], ['2', ['run-129', 'custom']], ['3', ['run-130', 'run-125']]].map(([letter, tags], index) =>
          ({ id: index + 1, name: `sha256:${(letter as string).repeat(64)}`, metadata: { container: { tags } } })),
      ]],
      [formalPath]: { tag_name: `v${version}`, draft: false, prerelease: false },
      [`repos/${candidates}/releases?per_page=100`]: [[
        ...['run-123', 'run-124', 'run-125', 'run-127', 'run-128', 'run-129', 'run-130'].map(tag_name => ({ tag_name, draft: false, prerelease: true })),
        { tag_name: 'run-126', draft: true, prerelease: true }, { tag_name: 'metadata', draft: false, prerelease: true },
      ]],
    }
    const invoke = async (script: string, args: string[], overrides = {}) => {
      await writeFile(join(root, 'responses.json'), JSON.stringify({ ...facts, ...overrides }))
      await writeFile(join(root, 'calls.jsonl'), '')
      const result = spawnSync(process.execPath, [resolve(`scripts/release/${script}.mjs`), ...args], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MAINTENANCE_FIXTURE_ROOT: root }, encoding: 'utf8',
      })
      const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[])
      return { result, calls }
    }
    const promoted = await invoke('promote', ['123'])
    expect(promoted.result.status, promoted.result.stderr).toBe(0)
    expect(promoted.calls.at(-1)).toEqual(['workflow', 'run', 'release.yml', '--repo', repository, '--ref', 'main', '-f', 'candidate_run=123', '-f', `version=${version}`, '-f', `acceptance_sha256=${sha256(acceptanceBytes)}`])
    const rejected = await invoke('promote', ['123'], { [`repos/${repository}/contents/releases/acceptance/${version}.md?ref=main`]: { content: Buffer.from('changed summary').toString('base64') } })
    expect(rejected.result.status).not.toBe(0)
    expect(rejected.calls.some(call => call[0] === 'workflow')).toBe(false)
    for (const override of [{ draft: true }, { prerelease: true }, { tag_name: 'v0.1.17' }]) {
      const blocked = await invoke('cleanup-candidates', [version, '--yes'], { [formalPath]: { tag_name: `v${version}`, draft: false, prerelease: false, ...override } })
      expect(blocked.result.status).not.toBe(0)
      expect(blocked.calls.some(call => call[1] === 'delete')).toBe(false)
    }
    expect((await invoke('cleanup-candidates', [version])).result.status).not.toBe(0)
    const cleaned = await invoke('cleanup-candidates', [version, '--yes'])
    expect(cleaned.result.status, cleaned.result.stderr).toBe(0)
    expect(cleaned.calls.filter(call => call[0] === 'api' && call.includes('DELETE'))).toEqual([['api', 'users/dake6767/packages/container/dsh-phalanx/versions/2', '--method', 'DELETE']])
    expect(cleaned.calls.filter(call => call[1] === 'delete')).toEqual(['run-123', 'run-124', 'run-127', 'run-128', 'run-129', 'run-130'].map(tag => ['release', 'delete', tag, '--repo', candidates, '--yes']))
    const selectedPath = join(root, 'run-124/manifest.json')
    const rehearsal = JSON.parse(await readFile(selectedPath, 'utf8'))
    rehearsal.imageSelection = { mode: 'build', reason: 'local-build', rehearsal: true, inputHash: 'd'.repeat(64), dshRevision: manifest.dshRevision, platform: 'linux/amd64' }
    await writeFile(selectedPath, JSON.stringify(rehearsal))
    const rehearsed = await invoke('cleanup-candidates', ['--rehearsal', '124', '--yes'])
    expect(rehearsed.result.status, rehearsed.result.stderr).toBe(0)
    expect(rehearsed.calls.filter(call => call[0] === 'api' && call.includes('DELETE'))).toEqual([['api', 'users/dake6767/packages/container/dsh-phalanx/versions/2', '--method', 'DELETE']])
    expect(rehearsed.calls.filter(call => call[1] === 'delete')).toEqual([['release', 'delete', 'run-124', '--repo', candidates, '--yes']])
    for (const runs of ['123', '126', '999', '124,123', '124,124']) {
      const blocked = await invoke('cleanup-candidates', ['--rehearsal', runs, '--yes'])
      expect(blocked.result.status).not.toBe(0)
      expect(blocked.calls.some(call => call.includes('DELETE') || call[1] === 'delete')).toBe(false)
    }
    await writeFile(join(root, 'v0.1.15/manifest.json'), '{}')
    const unreadable = await invoke('cleanup-candidates', ['--rehearsal', '124', '--yes'])
    expect(unreadable.result.status).not.toBe(0)
    expect(unreadable.calls.some(call => call.includes('DELETE') || call[1] === 'delete')).toBe(false)

  } finally { await rm(root, { recursive: true, force: true }) }
})
