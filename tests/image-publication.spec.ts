import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { imageName, sha256 } from '../scripts/release/integrity.mjs'

it('tags reused and promoted registry digests without uploading OCI bytes, preserving an existing input mapping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-publication-')),
    digest = `sha256:${'a'.repeat(64)}`
  const commit = 'b'.repeat(40),
    dshRevision = 'c'.repeat(40),
    inputHash = 'd'.repeat(64)
  const fixture = resolve('tests/fixtures/image-registry.mjs'),
    script = resolve('scripts/release/publish-image.mjs')
  const names = ['dsh-phalanx-linux-amd64.tar.gz', 'dsh-phalanx-dsh-linux-amd64.oci.tar']
  const manifest = {
    schema: 1,
    tag: 'v0.1.1-rc.123',
    targetVersion: '0.1.1',
    commit,
    platform: 'linux/amd64',
    runId: '123',
    dshRevision,
    toolchain: { node: '24.21.0', pnpm: '11.19.0' },
    files: Object.fromEntries(names.map(name => [name, sha256(name)])),
    image: { name: imageName, tag: '0.1.1-rc.123', digest, reference: `${imageName}@${digest}` },
    imageIdentity: { inputHash, dshRevision, digest, buildCommit: commit },
  }
  const selection = {
    mode: 'reuse',
    reason: 'input-match',
    rehearsal: true,
    inputHash,
    dshRevision,
    platform: 'linux/amd64',
    digest,
    reference: manifest.image.reference,
  }
  try {
    await mkdir(join(root, 'bin'))
    await writeFile(join(root, 'bin/skopeo'), `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o755 })
    for (const name of names) await writeFile(join(root, name), name)
    await writeFile(join(root, 'SHA256SUMS'), names.map(name => `${manifest.files[name]}  ${name}\n`).join(''))
    const invoke = (promotion = false) =>
      spawnSync(process.execPath, ['--import', fixture, script, root], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${root}/bin:${process.env.PATH}`,
          IMAGE_REGISTRY_FIXTURE: root,
          IMAGE_REGISTRY_DIGEST: digest,
          GITHUB_ACTOR: 'fixture',
          GH_TOKEN: 'fixture-token',
          PROMOTION_VERSION: promotion ? manifest.targetVersion : undefined,
        },
      })
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...manifest, imageSelection: selection }))
    await writeFile(join(root, 'registry.json'), JSON.stringify({ [`input-${inputHash}`]: `sha256:${'e'.repeat(64)}` }))
    let result = invoke()
    expect(result.status, result.stderr).toBe(0)
    let copies = (await readFile(join(root, 'copies.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[])
    expect(copies).toHaveLength(1)
    expect(copies[0]!.at(-2)).toBe(`docker://${manifest.image.reference}`)
    expect(JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'))[`input-${inputHash}`]).toBe(`sha256:${'e'.repeat(64)}`)
    expect(invoke(true).status).not.toBe(0)
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
    result = invoke(true)
    expect(result.status, result.stderr).toBe(0)
    copies = (await readFile(join(root, 'copies.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[])
    expect(copies.at(-1)!.at(-2)).toBe(`docker://${manifest.image.reference}`)
    expect(copies.every(args => args.includes('--preserve-digests'))).toBe(true)
    await writeFile(join(root, 'registry.json'), '{}')
    await writeFile(join(root, 'copies.jsonl'), '')
    result = invoke()
    expect(result.status, result.stderr).toBe(0)
    copies = (await readFile(join(root, 'copies.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[])
    expect(copies).toHaveLength(2)
    expect(copies[0]!.at(-2)).toBe(`oci-archive:${root}/${names[1]}`)
    expect(copies[1]!.at(-2)).toBe(`docker://${manifest.image.reference}`)
    expect(JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'))[`input-${inputHash}`]).toBe(digest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
