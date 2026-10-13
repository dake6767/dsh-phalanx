const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
export function versionParts(value) {
  if (typeof value !== 'string' || !versionPattern.test(value)) throw new Error('Invalid release version')
  const parts = value.split('.').map(Number)
  if (!parts.every(Number.isSafeInteger)) throw new Error('Invalid release version')
  return parts
}
export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}
const positive = value => Number.isSafeInteger(value) && value > 0
export const requiredAcceptance = ['ci', 'linux', 'cleanInstall', 'upgrade', 'review']
export function validateCompatibility(manifest) {
  if (manifest.schema === 1 && ['0.1.0', '0.1.1'].includes(manifest.targetVersion)) return
  const value = manifest.compatibility, accounts = value?.accounts, policy = manifest.acceptancePolicy
  if (manifest.schema !== 2 || ![1, 2, 3].includes(value?.protocol) || !positive(value.environmentEpoch) ||
      !positive(accounts?.sourceMin) || !positive(accounts?.sourceMax) || !positive(accounts?.target) ||
      accounts.sourceMin > accounts.sourceMax || accounts.target < accounts.sourceMax ||
      !positive(policy?.ticket) || !Array.isArray(policy.checks) ||
      new Set(policy.checks).size !== policy.checks.length || !policy.checks.every(key => typeof key === 'string' && /^[a-z][A-Za-z]*$/u.test(key)) ||
      !requiredAcceptance.every(key => policy.checks.includes(key))) throw new Error('Unsupported release compatibility protocol')
  if (compareVersions(manifest.targetVersion, '0.1.13') >= 0 && value.protocol !== 3) throw new Error('This release requires capacity-aware upgrade protocol 3')
  if (value.protocol === 3) {
    if (!['platformArchiveBytes', 'platformExpandedBytes', 'imageDownloadBytes', 'imageExpandedBytes'].every(key => positive(manifest.storage?.[key]))) throw new Error('Release storage requirements are missing or invalid')
    if (typeof manifest.updater !== 'string' || Buffer.byteLength(manifest.updater) > 16384) throw new Error('Release updater inventory is missing or unbounded')
  }
  const revisions = value.sourceDshRevisions
  if (value.protocol === 2) {
    if (!Array.isArray(revisions) || revisions.length === 0 ||
        !revisions.every(revision => typeof revision === 'string' && /^[a-f0-9]{40}$/u.test(revision)) ||
        new Set(revisions).size !== revisions.length) throw new Error('Runtime transition requires exact source DSH revisions')
  } else if (revisions !== undefined) throw new Error('Protocol 1 cannot declare a runtime transition')
  if (compareVersions(value.source?.min, value.source?.maxExclusive) >= 0 ||
      compareVersions(value.source.min, manifest.targetVersion) >= 0) throw new Error('Invalid upgrade source interval')
}
