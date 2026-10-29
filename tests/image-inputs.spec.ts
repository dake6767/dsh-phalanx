import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('binds image identity to the complete context, DSH, runtime pins, base digest and platform', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-inputs-'))
  const versions = { node: '24.21.0', pnpm: '11.19.0', dsh: { repository: 'https://example.test/dsh.git', revision: 'a'.repeat(40), pnpm: '11.28.5' } }
  const recipe = `ARG NODE_IMAGE=docker.io/library/node:24@sha256:${'b'.repeat(64)}\nFROM \${NODE_IMAGE}\nCOPY nested/helper.sh /helper.sh\n`
  const invoke = (extra: string[] = []) => {
    const result = spawnSync(process.execPath, [resolve('scripts/release/image-inputs.mjs'), root, '--platform', 'linux/amd64', ...extra], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  try {
    await mkdir(join(root, 'containers/dsh/nested'), { recursive: true })
    await writeFile(join(root, 'containers/dsh/Containerfile'), recipe)
    await writeFile(join(root, 'containers/dsh/nested/helper.sh'), 'echo original\n')
    await writeFile(join(root, 'runtime-versions.json'), JSON.stringify(versions))
    const original = invoke()
    expect(original.inputHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(original.dshRevision).toBe(versions.dsh.revision)
    expect(invoke()).toEqual(original)
    await writeFile(join(root, 'package.json'), '{"version":"0.1.99"}')
    expect(invoke()).toEqual(original)
    await writeFile(join(root, 'containers/dsh/nested/helper.sh'), 'echo changed\n')
    expect(invoke().inputHash).not.toBe(original.inputHash)
    await writeFile(join(root, 'containers/dsh/nested/helper.sh'), 'echo original\n')
    for (const changed of [
      { ...versions, node: '24.22.0' },
      { ...versions, dsh: { ...versions.dsh, repository: 'https://example.test/other.git' } },
      { ...versions, dsh: { ...versions.dsh, revision: 'c'.repeat(40) } },
      { ...versions, dsh: { ...versions.dsh, pnpm: '11.29.0' } },
    ]) {
      await writeFile(join(root, 'runtime-versions.json'), JSON.stringify(changed))
      expect(invoke().inputHash).not.toBe(original.inputHash)
    }
    await writeFile(join(root, 'runtime-versions.json'), JSON.stringify(versions))
    expect(invoke(['--node-image', `registry.example.test/node@sha256:${'d'.repeat(64)}`]).inputHash).not.toBe(original.inputHash)
    expect(invoke(['--node-image', `registry.example.test/node@sha256:${'b'.repeat(64)}`]).inputHash).toBe(original.inputHash)
    expect(invoke(['--platform', 'linux/arm64']).inputHash).not.toBe(original.inputHash)
    const before = await readFile(join(root, 'containers/dsh/Containerfile'), 'utf8')
    await writeFile(join(root, 'containers/dsh/Containerfile'), before + '# recipe change\n')
    expect(invoke().inputHash).not.toBe(original.inputHash)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects inconsistent image identity extensions through the release verification command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-manifest-'))
  const { createHash } = await import('node:crypto')
  const digest = `sha256:${'a'.repeat(64)}`
  const identity = { inputHash: 'b'.repeat(64), dshRevision: 'c'.repeat(40), digest, buildCommit: 'd'.repeat(40) }
  const names = ['dsh-phalanx-linux-amd64.tar.gz', 'dsh-phalanx-dsh-linux-amd64.oci.tar']
  const files = Object.fromEntries(names.map(name => [name, createHash('sha256').update(name).digest('hex')]))
  const manifest = {
    schema: 1,
    tag: 'v0.1.0-rc.1',
    targetVersion: '0.1.0',
    commit: 'e'.repeat(40),
    platform: 'linux/amd64',
    runId: '1',
    dshRevision: identity.dshRevision,
    toolchain: { node: '24.21.0', pnpm: '11.19.0' },
    image: { name: 'ghcr.io/dake6767/dsh-phalanx', tag: '0.1.0-rc.1', digest, reference: `ghcr.io/dake6767/dsh-phalanx@${digest}` },
    files,
  }
  const verify = async (value: unknown) => {
    await writeFile(join(root, 'manifest.json'), JSON.stringify(value))
    return spawnSync(process.execPath, [resolve('scripts/release/verify.mjs'), root], { encoding: 'utf8' })
  }
  try {
    for (const name of names) await writeFile(join(root, name), name)
    await writeFile(join(root, 'SHA256SUMS'), names.map(name => `${files[name]}  ${name}\n`).join(''))
    expect((await verify(manifest)).status).toBe(0)
    expect((await verify({ ...manifest, imageIdentity: identity })).status).toBe(0)
    for (const value of [
      null,
      { ...identity, inputHash: 'latest' },
      { ...identity, digest: `sha256:${'f'.repeat(64)}` },
      { ...identity, dshRevision: 'f'.repeat(40) },
      { ...identity, buildCommit: 'main' },
    ]) {
      expect((await verify({ ...manifest, imageIdentity: value })).status).toBe(1)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
