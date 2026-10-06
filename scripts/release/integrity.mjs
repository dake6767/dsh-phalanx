import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { validateCompatibility } from './compatibility.mjs'

export const imageName = 'ghcr.io/dake6767/dsh-phalanx'
export const candidatePattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.[1-9]\d*$/u
export const assetNames = ['dsh-phalanx-linux-amd64.tar.gz', 'dsh-phalanx-dsh-linux-amd64.oci.tar']
export const sha256 = data => createHash('sha256').update(data).digest('hex')
export async function fileHash(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function validateManifest(manifest, { tag, commit } = {}) {
  if (!candidatePattern.test(manifest.tag) ||
      !/^[a-f0-9]{40}$/u.test(manifest.commit) || manifest.targetVersion !== manifest.tag.split('-rc.')[0].slice(1) ||
      manifest.platform !== 'linux/amd64' || !/^[1-9]\d*$/u.test(manifest.runId) ||
      !/^[a-f0-9]{40}$/u.test(manifest.dshRevision) ||
      manifest.image?.name !== imageName || manifest.image.tag !== manifest.tag.slice(1) ||
      !/^sha256:[a-f0-9]{64}$/u.test(manifest.image.digest) ||
      manifest.image.reference !== `${imageName}@${manifest.image.digest}` ||
      !manifest.toolchain?.node || !manifest.toolchain.pnpm ||
      !manifest.files || Object.keys(manifest.files).sort().join() !== [...assetNames].sort().join() ||
      !assetNames.every(name => /^[a-f0-9]{64}$/u.test(manifest.files[name]))) {
    throw new Error('Invalid candidate manifest')
  }
  validateCompatibility(manifest)
  if (tag !== undefined && manifest.tag !== tag) throw new Error('Candidate tag mismatch')
  if (commit !== undefined && manifest.commit !== commit) throw new Error('Candidate commit mismatch')
  return manifest
}

export async function verifyDirectory(directory, expected = {}) {
  const manifest = validateManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), expected)
  const checksums = assetNames.map(name => `${manifest.files[name]}  ${name}\n`).join('')
  if (await readFile(join(directory, 'SHA256SUMS'), 'utf8') !== checksums) throw new Error('Checksum inventory mismatch')
  for (const name of assetNames) {
    if (await fileHash(join(directory, name)) !== manifest.files[name]) throw new Error(`Checksum mismatch: ${name}`)
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
