import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assetNames, imageName, sha256, validateManifest, verifyDirectory, requireSuccessfulJobs, validateAcceptance } from '../scripts/release/integrity.mjs'

const digest = `sha256:${'a'.repeat(64)}`
const manifest = () => ({ schema: 1, tag: 'v0.1.0-rc.1', targetVersion: '0.1.0', commit: 'b'.repeat(40), platform: 'linux/amd64',
  runId: '123', dshRevision: 'c'.repeat(40), toolchain: { node: '24.21.0', pnpm: '11.19.0' },
  image: { name: imageName, tag: '0.1.0-rc.1', digest, reference: `${imageName}@${digest}` },
  files: Object.fromEntries(assetNames.map(name => [name, sha256(name)])) })

it('requires every required job to succeed, including cancellation and skip outcomes', () => {
  expect(() => requireSuccessfulJobs({ checks: { result: 'success' } })).not.toThrow()
  for (const result of ['failure', 'cancelled', 'skipped', '']) expect(() => requireSuccessfulJobs({ checks: { result } })).toThrow()
  expect(() => requireSuccessfulJobs({})).toThrow()
})
it('rejects mismatched candidate identities, unsafe inventories and unsupported platforms', () => {
  expect(validateManifest(manifest(), { tag: 'v0.1.0-rc.1', commit: 'b'.repeat(40) })).toEqual(manifest())
  for (const change of [{ platform: 'darwin/arm64' }, { tag: 'v0.1.0' }, { files: { '../secret': 'a'.repeat(64) } }, { commit: 'main' }, { targetVersion: '0.1.1' }]) {
    expect(() => validateManifest({ ...manifest(), ...change })).toThrow()
  }
  const next = { ...manifest(), tag: 'v0.1.1-rc.1', targetVersion: '0.1.1', image: { ...manifest().image, tag: '0.1.1-rc.1' } }
  expect(validateManifest(next)).toEqual(next)
  expect(() => validateManifest(manifest(), { commit: 'd'.repeat(40) })).toThrow('commit mismatch')
})
it('explicitly fails corrupt downloads and changed checksum inventories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-integrity-'))
  const value = manifest()
  try {
    for (const name of assetNames) await writeFile(join(directory, name), name)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(value))
    const sums = assetNames.map(name => `${value.files[name]}  ${name}\n`).join('')
    await writeFile(join(directory, 'SHA256SUMS'), sums)
    expect(await verifyDirectory(directory)).toEqual(value)
    await writeFile(join(directory, assetNames[0]!), 'corrupted')
    await expect(verifyDirectory(directory)).rejects.toThrow('Checksum mismatch')
    await writeFile(join(directory, 'SHA256SUMS'), sums.replace(value.files[assetNames[0]!]!, '0'.repeat(64)))
    await expect(verifyDirectory(directory)).rejects.toThrow('inventory mismatch')
  } finally { await rm(directory, { recursive: true }) }
})
it('promotes only the exact accepted bytes, digest, run and complete ticket 14 checks', () => {
  const value = manifest(), hash = sha256('accepted summary')
  const acceptance = { schema: 1, ticket: 14, status: 'accepted', candidate: value.tag, commit: value.commit,
    runId: value.runId, platformSha256: value.files[assetNames[0]!], imageDigest: digest, summarySha256: hash,
    checks: { ci: 'passed', linux: 'passed', cleanInstall: 'passed', https: 'passed', dogfood: 'passed' } }
  expect(() => validateAcceptance(acceptance, value, hash)).not.toThrow()
  for (const change of [{ imageDigest: `sha256:${'f'.repeat(64)}` }, { runId: '999' }, { checks: { ...acceptance.checks, dogfood: 'pending' } }]) {
    expect(() => validateAcceptance({ ...acceptance, ...change }, value, hash)).toThrow()
  }
})
it('requires ticket 09 acceptance for 0.1.1 with every final integration check', () => {
  const value = { ...manifest(), tag: 'v0.1.1-rc.1', targetVersion: '0.1.1', image: { ...manifest().image, tag: '0.1.1-rc.1' } }
  const hash = sha256('0.1.1 accepted summary')
  const checks = { ci: 'passed', linux: 'passed', cleanInstall: 'passed', https: 'passed', models: 'passed', spaces: 'passed',
    recovery: 'passed', storage: 'passed', upgrade: 'passed', review: 'passed' }
  const acceptance = { schema: 1, ticket: 9, status: 'accepted', candidate: value.tag, commit: value.commit,
    runId: value.runId, platformSha256: value.files[assetNames[0]!], imageDigest: digest, summarySha256: hash, checks }
  expect(() => validateAcceptance(acceptance, value, hash)).not.toThrow()
  for (const key of Object.keys(checks)) {
    expect(() => validateAcceptance({ ...acceptance, checks: { ...checks, [key]: 'pending' } }, value, hash)).toThrow()
  }
  expect(() => validateAcceptance({ ...acceptance, ticket: 14 }, value, hash)).toThrow()
  expect(() => validateAcceptance(acceptance, manifest(), hash)).toThrow()
})

it('accepts future releases through declared protocol and data compatibility rather than a version whitelist', () => {
  const value = { ...manifest(), schema: 2, tag: 'v0.1.4-rc.2', targetVersion: '0.1.4',
    image: { ...manifest().image, tag: '0.1.4-rc.2' },
    compatibility: { protocol: 1, source: { min: '0.1.1', maxExclusive: '0.2.0' },
      accounts: { sourceMin: 4, sourceMax: 4, target: 4 }, environmentEpoch: 1 },
    acceptancePolicy: { ticket: 6, checks: ['ci', 'linux', 'cleanInstall', 'upgrade', 'review'] } }
  expect(validateManifest(value)).toEqual(value)
  for (const compatibility of [{ ...value.compatibility, protocol: 99 },
    { ...value.compatibility, source: { min: 'latest', maxExclusive: '0.2.0' } },
    { ...value.compatibility, accounts: { sourceMin: 5, sourceMax: 4, target: 4 } }]) {
    expect(() => validateManifest({ ...value, compatibility })).toThrow()
  }
  expect(() => validateManifest({ ...value, schema: 1 })).toThrow()
})
