import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { validateCompatibility, versionParts } from './compatibility.mjs'

export const imageName = 'ghcr.io/dake6767/dsh-phalanx'
const legacyCandidatePattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.[1-9]\d*$/u
export const candidatePattern = /^(?:v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.[1-9]\d*|run-[1-9]\d*)$/u
export function candidateImageTag(tag) {
  if (!candidatePattern.test(tag)) throw new Error('Invalid candidate identity')
  return legacyCandidatePattern.test(tag) ? tag.slice(1) : tag
}
export function assetNamesFor(platform) {
  if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('Unsupported artifact platform')
  const architecture = platform.split('/')[1]
  return [`dsh-phalanx-linux-${architecture}.tar.gz`, `dsh-phalanx-dsh-linux-${architecture}.oci.tar`]
}
export const assetNames = assetNamesFor('linux/amd64')
export const sha256 = data => createHash('sha256').update(data).digest('hex')
export async function fileHash(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function validateManifest(manifest, { tag, commit, platform = 'linux/amd64' } = {}) {
  const names = assetNamesFor(platform)
  versionParts(manifest.targetVersion)
  const identityMatches = legacyCandidatePattern.test(manifest.tag)
    ? manifest.targetVersion === manifest.tag.split('-rc.')[0].slice(1)
    : manifest.schema === 2 && manifest.tag === `run-${manifest.runId}`
  if (!candidatePattern.test(manifest.tag) ||
      !/^[a-f0-9]{40}$/u.test(manifest.commit) || !identityMatches ||
      manifest.platform !== platform || !/^[1-9]\d*$/u.test(manifest.runId) ||
      !/^[a-f0-9]{40}$/u.test(manifest.dshRevision) ||
      manifest.image?.name !== imageName || manifest.image.tag !== candidateImageTag(manifest.tag) ||
      !/^sha256:[a-f0-9]{64}$/u.test(manifest.image.digest) ||
      manifest.image.reference !== `${imageName}@${manifest.image.digest}` ||
      !manifest.toolchain?.node || !manifest.toolchain.pnpm ||
      !manifest.files || Object.keys(manifest.files).sort().join() !== [...names].sort().join() ||
      !names.every(name => /^[a-f0-9]{64}$/u.test(manifest.files[name]))) {
    throw new Error('Invalid candidate manifest')
  }
  if (manifest.updaterAsset !== undefined && (manifest.updaterAsset?.name !== 'updater.json' ||
      !/^[a-f0-9]{64}$/u.test(manifest.updaterAsset?.sha256))) throw new Error('Invalid updater asset identity')
  validateCompatibility(manifest)
  if (tag !== undefined && manifest.tag !== tag) throw new Error('Candidate tag mismatch')
  if (commit !== undefined && manifest.commit !== commit) throw new Error('Candidate commit mismatch')
  return manifest
}

export async function verifyDirectory(directory, expected = {}) {
  const manifest = validateManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), expected)
  const names = assetNamesFor(manifest.platform)
  const checksums = names.map(name => `${manifest.files[name]}  ${name}\n`).join('')
  if (await readFile(join(directory, 'SHA256SUMS'), 'utf8') !== checksums) throw new Error('Checksum inventory mismatch')
  for (const name of names) {
    if (await fileHash(join(directory, name)) !== manifest.files[name]) throw new Error(`Checksum mismatch: ${name}`)
  }
  if (manifest.updaterAsset && await fileHash(join(directory, manifest.updaterAsset.name)) !== manifest.updaterAsset.sha256) {
    throw new Error('Updater asset checksum mismatch')
  }
  return manifest
}

export function requireSuccessfulJobs(results) {
  if (!results || Object.keys(results).length === 0 || Object.values(results).some(job => job.result !== 'success')) {
    throw new Error('Every required job must succeed; failures, cancellations and skips fail the gate')
  }
}

const acceptancePolicies = {
  '0.1.0': { ticket: 14, checks: ['ci', 'linux', 'cleanInstall', 'https', 'dogfood'] },
  '0.1.1': { ticket: 9, checks: ['ci', 'linux', 'cleanInstall', 'https', 'models', 'spaces', 'recovery', 'storage', 'upgrade', 'review'] },
}

export function validateAcceptance(acceptance, manifest, summaryHash) {
  const policy = manifest.schema === 2 ? manifest.acceptancePolicy : acceptancePolicies[manifest.targetVersion]
  if (policy === undefined || acceptance.schema !== 1 || acceptance.ticket !== policy.ticket || acceptance.status !== 'accepted' ||
      acceptance.candidate !== manifest.tag || acceptance.commit !== manifest.commit ||
      acceptance.runId !== manifest.runId || acceptance.platformSha256 !== manifest.files[assetNames[0]] ||
      acceptance.imageDigest !== manifest.image.digest || acceptance.summarySha256 !== summaryHash ||
      !policy.checks.every(key => acceptance.checks?.[key] === 'passed')) {
    throw new Error('Promotion requires the matching completed acceptance record')
  }
}
