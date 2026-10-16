import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('selects reused or rebuilt images by registry identity, explicit override and supported upgrade baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-reuse-'))
  const digest = `sha256:${'a'.repeat(64)}`, paths: string[] = []
  let registryStatus = 200
  const registry = createServer((request, response) => {
    paths.push(request.url!)
    if (request.url!.startsWith('/token?')) response.end(JSON.stringify({ token: 'fixture-registry-token' }))
    else { response.statusCode = registryStatus; response.setHeader('docker-content-digest', digest); response.end('{}') }
  })
  registry.listen(0, '127.0.0.1'); await once(registry, 'listening')
  try {
    await mkdir(join(root, 'containers/dsh'), { recursive: true })
    await writeFile(join(root, 'containers/dsh/Containerfile'), `ARG NODE_IMAGE=node@sha256:${'b'.repeat(64)}\nFROM \${NODE_IMAGE}\n`)
    await writeFile(join(root, 'runtime-versions.json'), JSON.stringify({ node: '24.21.0', dsh: { repository: 'https://example.test/dsh.git', revision: 'c'.repeat(40), pnpm: '11.28.5' } }))
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.18' }))
    await writeFile(join(root, 'release-policy.json'), JSON.stringify({ compatibility: { source: { min: '0.1.17', maxExclusive: '0.1.18' } } }))
    const output = join(root, 'selection.json'), origin = `http://127.0.0.1:${(registry.address() as { port: number }).port}`
    const select = async (extra: string[] = []) => {
      await promisify(execFile)(process.execPath, [resolve('scripts/release/select-image.mjs'), output, '--registry-origin', origin, ...extra], { cwd: root })
      return JSON.parse(await readFile(output, 'utf8'))
    }
    await select()
    const selection = JSON.parse(await readFile(output, 'utf8'))
    expect(selection).toMatchObject({ mode: 'reuse', reason: 'input-match', rehearsal: false, platform: 'linux/amd64', digest, reference: `ghcr.io/dake6767/dsh-phalanx@${digest}` })
    expect(selection.inputHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(paths).toContain(`/v2/dake6767/dsh-phalanx/manifests/input-${selection.inputHash}`)
    registryStatus = 404
    expect(await select()).toMatchObject({ mode: 'build', reason: 'not-found', rehearsal: false })
    registryStatus = 503
    await expect(select()).rejects.toThrow('HTTP 503')
    registryStatus = 200
    expect(await select(['--force-rebuild'])).toMatchObject({ mode: 'build', reason: 'forced', rehearsal: false })
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.17' }))
    await writeFile(join(root, 'release-policy.json'), JSON.stringify({ compatibility: { source: { min: '0.1.16', maxExclusive: '0.1.17' } } }))
    expect(await select()).toMatchObject({ mode: 'build', reason: 'legacy-baseline', rehearsal: false })
    expect(await select(['--reuse-rehearsal'])).toMatchObject({ mode: 'reuse', rehearsal: true, digest })
    expect(await select(['--reuse-rehearsal', '--force-rebuild'])).toMatchObject({ mode: 'build', reason: 'forced', rehearsal: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.19' }))
    expect(await select()).toMatchObject({ mode: 'build', reason: 'legacy-baseline' })
    expect(await select(['--platform', 'linux/arm64'])).toMatchObject({ mode: 'build', platform: 'linux/arm64', reason: 'development-platform' })
  } finally {
    registry.closeAllConnections(); await new Promise<void>(resolve => registry.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

it('verifies reuse decisions against image identity and refuses production reuse across a legacy baseline', async () => {
  const { sha256 } = await import('../scripts/release/integrity.mjs')
  const root = await mkdtemp(join(tmpdir(), 'reuse-manifest-'))
  const digest = `sha256:${'a'.repeat(64)}`, commit = 'b'.repeat(40), inputHash = 'c'.repeat(64), dshRevision = 'd'.repeat(40)
  const names = ['dsh-phalanx-linux-amd64.tar.gz', 'dsh-phalanx-dsh-linux-amd64.oci.tar']
  const selection = { mode: 'reuse', reason: 'input-match', rehearsal: true, inputHash, dshRevision, platform: 'linux/amd64', digest,
    reference: `ghcr.io/dake6767/dsh-phalanx@${digest}` }
  const manifest = { schema: 2, tag: 'run-123', targetVersion: '0.1.17', commit, platform: 'linux/amd64', runId: '123', dshRevision,
    toolchain: { node: '24.21.0', pnpm: '11.19.0' },
    image: { name: 'ghcr.io/dake6767/dsh-phalanx', tag: 'run-123', digest, reference: selection.reference },
    imageIdentity: { inputHash, dshRevision, digest, buildCommit: 'e'.repeat(40) },
    imageSelection: selection, files: Object.fromEntries(names.map(name => [name, sha256(name)])),
    compatibility: { protocol: 3, source: { min: '0.1.16', maxExclusive: '0.1.17' }, accounts: { sourceMin: 5, sourceMax: 5, target: 5 }, environmentEpoch: 1 },
    acceptancePolicy: { ticket: 8, checks: ['ci', 'linux', 'cleanInstall', 'upgrade', 'review'] }, updater: '{}',
    storage: { platformArchiveBytes: 1, platformExpandedBytes: 1, imageDownloadBytes: 1, imageExpandedBytes: 1 } }
  const verify = async (imageSelection: unknown) => {
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...manifest, imageSelection }))
    return promisify(execFile)(process.execPath, [resolve('scripts/release/verify.mjs'), root])
  }
  try {
    for (const name of names) await writeFile(join(root, name), name)
    await writeFile(join(root, 'SHA256SUMS'), names.map(name => `${manifest.files[name]}  ${name}\n`).join(''))
    await verify(selection)
    for (const invalid of [{ ...selection, rehearsal: false }, { ...selection, inputHash: 'f'.repeat(64) },
      { ...selection, digest: `sha256:${'f'.repeat(64)}` }, { ...selection, rehearsal: 'true' },
      { ...selection, mode: 'build' }, { ...selection, reason: 'forced' }]) await expect(verify(invalid)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
