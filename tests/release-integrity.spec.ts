import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assetNames, imageName, sha256, validateManifest, verifyDirectory, requireSuccessfulJobs, validateAcceptance } from '../scripts/release/integrity.mjs'

const digest = `sha256:${'a'.repeat(64)}`
const manifest = () => ({
  schema: 1,
  tag: 'v0.1.0-rc.1',
  targetVersion: '0.1.0',
  commit: 'b'.repeat(40),
  platform: 'linux/amd64',
  runId: '123',
  dshRevision: 'c'.repeat(40),
  toolchain: { node: '24.21.0', pnpm: '11.19.0' },
  image: { name: imageName, tag: '0.1.0-rc.1', digest, reference: `${imageName}@${digest}` },
  files: Object.fromEntries(assetNames.map(name => [name, sha256(name)])),
})

it('verifies native arm64 development bundles only with explicit platform opt-in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'development-integrity-'))
  const names = ['dsh-phalanx-linux-arm64.tar.gz', 'dsh-phalanx-dsh-linux-arm64.oci.tar']
  const value = { ...manifest(), platform: 'linux/arm64', files: Object.fromEntries(names.map(name => [name, sha256(name)])) }
  try {
    for (const name of names) await writeFile(join(directory, name), name)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(value))
    await writeFile(join(directory, 'SHA256SUMS'), names.map(name => `${value.files[name]}  ${name}\n`).join(''))
    await expect(verifyDirectory(directory)).rejects.toThrow('Invalid candidate manifest')
    expect(await verifyDirectory(directory, { platform: 'linux/arm64' })).toEqual(value)
    await writeFile(join(directory, names[0]!), 'corrupted')
    await expect(verifyDirectory(directory, { platform: 'linux/arm64' })).rejects.toThrow('Checksum mismatch')
  } finally {
    await rm(directory, { recursive: true })
  }
})

it('requires every required job to succeed, including cancellation and skip outcomes', () => {
  expect(() => requireSuccessfulJobs({ checks: { result: 'success' } })).not.toThrow()
  for (const result of ['failure', 'cancelled', 'skipped', '']) expect(() => requireSuccessfulJobs({ checks: { result } })).toThrow()
  expect(() => requireSuccessfulJobs({})).toThrow()
})
it('rejects mismatched candidate identities, unsafe inventories and unsupported platforms', () => {
  expect(validateManifest(manifest(), { tag: 'v0.1.0-rc.1', commit: 'b'.repeat(40) })).toEqual(manifest())
  for (const change of [
    { platform: 'darwin/arm64' },
    { tag: 'v0.1.0' },
    { files: { '../secret': 'a'.repeat(64) } },
    { commit: 'main' },
    { targetVersion: '0.1.1' },
  ]) {
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
  } finally {
    await rm(directory, { recursive: true })
  }
})
it('promotes only the exact accepted bytes, digest, run and complete ticket 14 checks', () => {
  const value = manifest(),
    hash = sha256('accepted summary')
  const acceptance = {
    schema: 1,
    ticket: 14,
    status: 'accepted',
    candidate: value.tag,
    commit: value.commit,
    runId: value.runId,
    platformSha256: value.files[assetNames[0]!],
    imageDigest: digest,
    summarySha256: hash,
    checks: { ci: 'passed', linux: 'passed', cleanInstall: 'passed', https: 'passed', dogfood: 'passed' },
  }
  expect(() => validateAcceptance(acceptance, value, hash)).not.toThrow()
  for (const change of [{ imageDigest: `sha256:${'f'.repeat(64)}` }, { runId: '999' }, { checks: { ...acceptance.checks, dogfood: 'pending' } }]) {
    expect(() => validateAcceptance({ ...acceptance, ...change }, value, hash)).toThrow()
  }
})
it('requires ticket 09 acceptance for 0.1.1 with every final integration check', () => {
  const value = { ...manifest(), tag: 'v0.1.1-rc.1', targetVersion: '0.1.1', image: { ...manifest().image, tag: '0.1.1-rc.1' } }
  const hash = sha256('0.1.1 accepted summary')
  const checks = {
    ci: 'passed',
    linux: 'passed',
    cleanInstall: 'passed',
    https: 'passed',
    models: 'passed',
    spaces: 'passed',
    recovery: 'passed',
    storage: 'passed',
    upgrade: 'passed',
    review: 'passed',
  }
  const acceptance = {
    schema: 1,
    ticket: 9,
    status: 'accepted',
    candidate: value.tag,
    commit: value.commit,
    runId: value.runId,
    platformSha256: value.files[assetNames[0]!],
    imageDigest: digest,
    summarySha256: hash,
    checks,
  }
  expect(() => validateAcceptance(acceptance, value, hash)).not.toThrow()
  for (const key of Object.keys(checks)) {
    expect(() => validateAcceptance({ ...acceptance, checks: { ...checks, [key]: 'pending' } }, value, hash)).toThrow()
  }
  expect(() => validateAcceptance({ ...acceptance, ticket: 14 }, value, hash)).toThrow()
  expect(() => validateAcceptance(acceptance, manifest(), hash)).toThrow()
})

it('accepts future releases through declared protocol and data compatibility rather than a version whitelist', () => {
  const value = {
    ...manifest(),
    schema: 2,
    tag: 'v0.1.4-rc.2',
    targetVersion: '0.1.4',
    image: { ...manifest().image, tag: '0.1.4-rc.2' },
    compatibility: { protocol: 1, source: { min: '0.1.1', maxExclusive: '0.2.0' }, accounts: { sourceMin: 4, sourceMax: 4, target: 4 }, environmentEpoch: 1 },
    acceptancePolicy: { ticket: 6, checks: ['ci', 'linux', 'cleanInstall', 'upgrade', 'review'] },
  }
  expect(validateManifest(value)).toEqual(value)
  for (const compatibility of [
    { ...value.compatibility, protocol: 99 },
    { ...value.compatibility, source: { min: 'latest', maxExclusive: '0.2.0' } },
    { ...value.compatibility, accounts: { sourceMin: 5, sourceMax: 4, target: 4 } },
  ]) {
    expect(() => validateManifest({ ...value, compatibility })).toThrow()
  }
  expect(() => validateManifest({ ...value, schema: 1 })).toThrow()
})

it('requires immutable source revisions for an explicitly declared runtime transition', () => {
  const value = {
    ...manifest(),
    schema: 2,
    tag: 'v0.1.10-rc.1',
    targetVersion: '0.1.10',
    image: { ...manifest().image, tag: '0.1.10-rc.1' },
    compatibility: {
      protocol: 2,
      source: { min: '0.1.9', maxExclusive: '0.1.10' },
      accounts: { sourceMin: 5, sourceMax: 5, target: 5 },
      environmentEpoch: 1,
      sourceDshRevisions: ['b'.repeat(40)],
    },
    acceptancePolicy: { ticket: 14, checks: ['ci', 'linux', 'cleanInstall', 'upgrade', 'review'] },
  }
  expect(validateManifest(value)).toEqual(value)
  for (const sourceDshRevisions of [undefined, [], ['latest'], ['b'.repeat(40), 'b'.repeat(40)]]) {
    expect(() => validateManifest({ ...value, compatibility: { ...value.compatibility, sourceDshRevisions } })).toThrow()
  }
  expect(() => validateManifest({ ...value, compatibility: { ...value.compatibility, protocol: 1 } })).toThrow()
})

it('requires capacity-aware metadata for releases after the legacy updater protocol', () => {
  const value = {
    ...manifest(),
    schema: 2,
    tag: 'v0.1.13-rc.1',
    targetVersion: '0.1.13',
    image: { ...manifest().image, tag: '0.1.13-rc.1' },
    compatibility: { protocol: 3, source: { min: '0.1.12', maxExclusive: '0.1.13' }, accounts: { sourceMin: 5, sourceMax: 5, target: 5 }, environmentEpoch: 1 },
    acceptancePolicy: { ticket: 12, checks: ['ci', 'linux', 'cleanInstall', 'upgrade', 'review'] },
    storage: { platformArchiveBytes: 100, platformExpandedBytes: 200, imageDownloadBytes: 300, imageExpandedBytes: 400 },
    updater: '{}',
  }
  expect(validateManifest(value)).toEqual(value)
  expect(validateManifest({ ...value, compatibility: { ...value.compatibility, sourceDshRevisions: ['b'.repeat(40)] } })).toBeDefined()
  for (const sourceDshRevisions of [null, [], ['latest'], ['b'.repeat(40), 'b'.repeat(40)]]) {
    expect(() => validateManifest({ ...value, compatibility: { ...value.compatibility, sourceDshRevisions } })).toThrow()
  }
  for (const change of [
    { storage: undefined },
    { updater: undefined },
    { storage: { ...value.storage, imageDownloadBytes: 0 } },
    { compatibility: { ...value.compatibility, protocol: 1 } },
  ])
    expect(() => validateManifest({ ...value, ...change })).toThrow()
})

it('binds a run-addressed candidate to its source commit, run and accepted bytes', () => {
  const value = {
    ...manifest(),
    schema: 2,
    tag: 'run-123',
    targetVersion: '0.1.16',
    image: { ...manifest().image, tag: 'run-123' },
    compatibility: { protocol: 3, source: { min: '0.1.13', maxExclusive: '0.1.16' }, accounts: { sourceMin: 5, sourceMax: 5, target: 5 }, environmentEpoch: 1 },
    acceptancePolicy: { ticket: 8, checks: ['ci', 'linux', 'cleanInstall', 'upgrade', 'review'] },
    storage: { platformArchiveBytes: 100, platformExpandedBytes: 200, imageDownloadBytes: 300, imageExpandedBytes: 400 },
    updater: '{}',
  }
  expect(validateManifest(value, { commit: value.commit, tag: 'run-123' })).toEqual(value)
  for (const change of [{ runId: '124' }, { tag: 'run-0123' }, { targetVersion: 'latest' }, { image: { ...value.image, tag: '123' } }, { schema: 1 }]) {
    expect(() => validateManifest({ ...value, ...change })).toThrow()
  }
  expect(() => validateManifest(value, { commit: 'd'.repeat(40) })).toThrow('commit mismatch')
  const summary = sha256('accepted run summary')
  const acceptance = {
    schema: 1,
    ticket: 8,
    status: 'accepted',
    candidate: 'run-123',
    commit: value.commit,
    runId: '123',
    platformSha256: value.files[assetNames[0]!],
    imageDigest: digest,
    summarySha256: summary,
    checks: { ci: 'passed', linux: 'passed', cleanInstall: 'passed', upgrade: 'passed', review: 'passed' },
  }
  expect(() => validateAcceptance(acceptance, value, summary)).not.toThrow()
  expect(() => validateAcceptance({ ...acceptance, runId: '124' }, value, summary)).toThrow()
})

it('accepts the three blocking checks and conditional clean installation while retaining historical declared checks', () => {
  const value = {
    ...manifest(),
    schema: 2,
    tag: 'run-123',
    targetVersion: '0.1.24',
    image: { ...manifest().image, tag: 'run-123' },
    compatibility: { protocol: 3, source: { min: '0.1.23', maxExclusive: '0.1.24' }, accounts: { sourceMin: 5, sourceMax: 5, target: 5 }, environmentEpoch: 1 },
    acceptancePolicy: { ticket: 8, checks: ['ci', 'linux', 'upgrade'] },
    storage: { platformArchiveBytes: 1, platformExpandedBytes: 1, imageDownloadBytes: 1, imageExpandedBytes: 1 },
    updater: '{}',
  }
  const summary = sha256('passed; run 123; digest')
  const receipt = {
    schema: 1,
    ticket: 8,
    status: 'accepted',
    candidate: value.tag,
    commit: value.commit,
    runId: value.runId,
    platformSha256: value.files[assetNames[0]!],
    imageDigest: digest,
    summarySha256: summary,
    checks: { ci: 'passed', linux: 'passed', upgrade: 'passed' },
  }
  expect(validateManifest(value)).toEqual(value)
  expect(() => validateAcceptance(receipt, value, summary)).not.toThrow()
  const clean = { ...value, acceptancePolicy: { ticket: 8, checks: [...value.acceptancePolicy.checks, 'cleanInstall'] } }
  expect(validateManifest(clean)).toEqual(clean)
  expect(() => validateManifest({ ...value, acceptancePolicy: { ticket: 8, checks: [...value.acceptancePolicy.checks, 'https'] } })).toThrow()
  expect(() => validateAcceptance(receipt, clean, summary)).toThrow()
  expect(() => validateAcceptance({ ...receipt, checks: { ...receipt.checks, cleanInstall: 'waived' } }, clean, summary)).toThrow()
  expect(() => validateAcceptance({ ...receipt, checks: { ...receipt.checks, cleanInstall: 'passed' } }, clean, summary)).not.toThrow()
  expect(() => validateManifest({ ...value, targetVersion: '0.1.23' })).toThrow()
  expect(() => validateManifest({ ...value, acceptancePolicy: { ticket: 8, checks: ['ci', 'linux'] } })).toThrow()
})

it('validates an explicit fresh-install boundary while preserving legacy schema refusal', () => {
  const value = {
    ...manifest(),
    schema: 2,
    tag: 'run-123',
    targetVersion: '0.1.25',
    image: { ...manifest().image, tag: 'run-123' },
    compatibility: {
      protocol: 3,
      source: { min: '0.1.24', maxExclusive: '0.1.25' },
      accounts: { sourceMin: 6, sourceMax: 6, target: 6 },
      environmentEpoch: 1,
      freshInstallThrough: '0.1.24',
    },
    acceptancePolicy: { ticket: 9, checks: ['ci', 'linux', 'upgrade', 'cleanInstall'] },
    storage: { platformArchiveBytes: 1, platformExpandedBytes: 1, imageDownloadBytes: 1, imageExpandedBytes: 1 },
    updater: '{}',
  }
  expect(validateManifest(value)).toEqual(value)
  for (const freshInstallThrough of [null, 'latest', '0.1.25', '0.2.0']) {
    expect(() => validateManifest({ ...value, compatibility: { ...value.compatibility, freshInstallThrough } })).toThrow()
  }
  expect(() => validateManifest({ ...value, compatibility: { ...value.compatibility, accounts: { sourceMin: 5, sourceMax: 6, target: 6 } } })).toThrow()
})

it('validates forward-compatible schema declarations without making upgrade decisions', async () => {
  const { readFile } = await import('node:fs/promises')
  const cases = JSON.parse(await readFile('scripts/release/compatibility-cases.json', 'utf8'))
  const { validateCompatibility } = await import('../scripts/release/compatibility.mjs')
  for (const sample of cases) expect(() => validateCompatibility(sample.target)).not.toThrow()
  for (const change of [{ schemas: [] }, { upgradeFloor: '0.2.0' }, { breakpoints: [{ version: '0.2.0', environmentEpoch: 1 }] }]) {
    const value = structuredClone(cases[0].target)
    Object.assign(value.compatibility, change)
    expect(() => validateCompatibility(value)).toThrow()
  }
})
