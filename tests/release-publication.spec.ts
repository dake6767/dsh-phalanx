import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { assetNames, imageName, sha256 } from '../scripts/release/integrity.mjs'

it('recovers a partial draft, rejects changed bytes, retries complete candidates and promotes unchanged assets in an isolated sample', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-publication-'))
  try {
    const directory = join(root, 'assets'), bin = join(root, 'bin')
    await mkdir(directory); await mkdir(bin)
    await writeFile(join(bin, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${resolve('tests/fixtures/release-gh.mjs')}' "$@"\n`, { mode: 0o755 })
    const digest = `sha256:${'a'.repeat(64)}`, commit = 'b'.repeat(40)
    const manifest = { schema: 1, tag: 'v0.1.0-rc.1', targetVersion: '0.1.0', commit, platform: 'linux/amd64', runId: '123',
      dshRevision: 'c'.repeat(40), toolchain: { node: '24.21.0', pnpm: '11.19.0' },
      image: { name: imageName, tag: '0.1.0-rc.1', digest, reference: `${imageName}@${digest}` },
      files: Object.fromEntries(assetNames.map(name => [name, sha256(name)])) }
    for (const name of assetNames) await writeFile(join(directory, name), name)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'SHA256SUMS'), assetNames.map(name => `${manifest.files[name]}  ${name}\n`).join(''))
    await writeFile(join(root, 'state.json'), JSON.stringify({ refs: [{ ref: `refs/tags/${manifest.tag}`, object: { type: 'commit', sha: commit } }], releases: [] }))
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_FIXTURE_ROOT: root, GITHUB_REPOSITORY: 'fixture/sample', CANDIDATE_TAG: manifest.tag, CANDIDATE_SHA: commit }
    const invoke = (changes = {}) => spawnSync(process.execPath, ['scripts/release/publish-release.mjs', directory], { env: { ...env, ...changes }, encoding: 'utf8' })
    const state = async () => JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as { refs: { ref: string; object: { sha: string } }[]; releases: { draft: boolean; assets: { name: string }[] }[] }
    expect(invoke({ RELEASE_FIXTURE_FAIL_ASSET: 'SHA256SUMS', RELEASE_FIXTURE_STALE_LIST: 'true' }).status).not.toBe(0)
    expect((await state()).releases[0]!.draft).toBe(true)
    expect((await state()).releases[0]!.assets).toHaveLength(2)
    expect(invoke().status).toBe(0)
    expect((await state()).releases[0]!.draft).toBe(false)
    expect(invoke().status).toBe(0)
    const initial = await readFile(join(directory, assetNames[0]!))
    await writeFile(join(root, manifest.tag, assetNames[0]!), 'conflicting uploaded bytes')
    expect(invoke().status).not.toBe(0)
    await writeFile(join(root, manifest.tag, assetNames[0]!), initial)
    for (const name of ['acceptance.json', 'acceptance.md', 'release.json']) await writeFile(join(directory, name), 'isolated sample only')
    expect(invoke({ PROMOTION_VERSION: '0.1.0', RELEASE_FIXTURE_STALE_LIST: 'true' }).status).toBe(0)
    expect((await state()).refs.find(item => item.ref === 'refs/tags/v0.1.0')?.object.sha).toBe(commit)
    expect((await state()).releases[1]!.draft).toBe(false)
    expect(await readFile(join(root, 'v0.1.0', assetNames[0]!))).toEqual(initial)
    expect(invoke({ PROMOTION_VERSION: '0.1.0' }).status).toBe(0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
