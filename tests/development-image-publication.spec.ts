import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { sha256 } from '../scripts/release/integrity.mjs'

it('publishes only the independent development package, skips existing inputs, and retains the latest two hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'development-publication-'))
  try {
    await mkdir(join(root, 'bin'))
    const fixture = resolve('tests/fixtures/image-registry.mjs')
    await writeFile(join(root, 'bin/skopeo'), `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o755 })
    await writeFile(join(root, 'bin/gh'), `#!/bin/sh\nexec '${process.execPath}' '${resolve('tests/fixtures/release-maintenance-gh.mjs')}' "$@"\n`, {
      mode: 0o755,
    })
    const inputs = JSON.parse(spawnSync(process.execPath, ['scripts/release/image-inputs.mjs', '--platform', 'linux/arm64'], { encoding: 'utf8' }).stdout)
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    const raw = '{"schemaVersion":2,"layers":[]}',
      digest = `sha256:${sha256(raw)}`
    const labels = {
      'dsh.input.sha256': inputs.inputHash,
      'dsh.revision': inputs.dshRevision,
      'org.opencontainers.image.revision': commit,
      'org.opencontainers.image.source': 'https://github.com/dake6767/dsh-phalanx',
      'dsh.development': 'unsupported',
      'org.opencontainers.image.description': 'For development only; unsupported',
    }
    await writeFile(join(root, 'raw.json'), raw)
    await writeFile(join(root, 'config.json'), JSON.stringify({ os: 'linux', architecture: 'arm64', config: { User: 'node', Labels: labels } }))
    await writeFile(join(root, 'registry.json'), '{}')
    await writeFile(join(root, 'calls.jsonl'), '')
    const packagePath = 'users/dake6767/packages/container/dsh-phalanx-dev/versions'
    await writeFile(
      join(root, 'responses.json'),
      JSON.stringify({
        'repos/dake6767/dsh-phalanx': { private: false },
        'repos/dake6767/dsh-phalanx/git/ref/heads/candidate/0.1.27': { object: { type: 'commit', sha: commit } },
        [`${packagePath}?per_page=100`]: [
          [
            ...[inputs.inputHash, 'a'.repeat(64), 'b'.repeat(64)].map((hash, index) => ({
              id: index + 1,
              name: index === 0 ? digest : `sha256:${hash}`,
              created_at: `2026-10-${20 - index}T00:00:00Z`,
              metadata: { container: { tags: [hash] } },
            })),
          ],
        ],
      }),
    )
    const invoke = (changes = {}) =>
      spawnSync(process.execPath, ['--import', fixture, resolve('scripts/release/publish-development-image.mjs'), root], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${root}/bin:${process.env.PATH}`,
          IMAGE_REGISTRY_FIXTURE: root,
          IMAGE_REGISTRY_DIGEST: digest,
          MAINTENANCE_FIXTURE_ROOT: root,
          GITHUB_REPOSITORY: 'dake6767/dsh-phalanx',
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_REF: 'refs/heads/candidate/0.1.27',
          GITHUB_SHA: commit,
          GITHUB_ACTOR: 'fixture',
          GH_TOKEN: 'fixture-token',
          ...changes,
        },
      })
    for (const changes of [{ GITHUB_REF: 'refs/heads/main' }, { GITHUB_REF: 'refs/heads/candidate/0.1.28' }, { GITHUB_SHA: 'f'.repeat(40) }])
      expect(invoke(changes).status).not.toBe(0)
    let result = invoke()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'))[inputs.inputHash]).toBe(digest)
    result = invoke()
    expect(result.status, result.stderr).toBe(0)
    const copies = (await readFile(join(root, 'copies.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[])
    expect(copies).toHaveLength(1)
    expect(copies[0]!.at(-1)).toBe(`docker://ghcr.io/dake6767/dsh-phalanx-dev:${inputs.inputHash}`)
    const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[])
    expect(calls.filter(call => call.includes('DELETE'))).toEqual(Array.from({ length: 2 }, () => ['api', `${packagePath}/3`, '--method', 'DELETE']))
    expect(calls.filter(call => call.includes('DELETE')).every(call => call[1]?.startsWith(packagePath))).toBe(true)
    expect(JSON.parse(await readFile(join(root, 'development-image.json'), 'utf8'))).toMatchObject({ inputHash: inputs.inputHash, digest, unsupported: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
