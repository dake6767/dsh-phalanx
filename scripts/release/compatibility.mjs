const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
export function versionParts(value) {
  if (typeof value !== 'string' || !versionPattern.test(value)) throw new Error('Invalid release version')
  const parts = value.split('.').map(Number)
  if (!parts.every(Number.isSafeInteger)) throw new Error('Invalid release version')
  return parts
}
export function compareVersions(left, right) {
  const a = versionParts(left),
    b = versionParts(right)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}
const positive = value => Number.isSafeInteger(value) && value > 0
export const requiredAcceptance = ['ci', 'linux', 'cleanInstall', 'upgrade', 'review']
export function validateCompatibility(manifest) {
  if (manifest.schema === 1 && ['0.1.0', '0.1.1'].includes(manifest.targetVersion)) return
  const value = manifest.compatibility,
    accounts = value?.accounts,
    policy = manifest.acceptancePolicy
  const current = compareVersions(manifest.targetVersion, '0.1.24') >= 0
  if (
    manifest.schema !== 2 ||
    !positive(value?.protocol) ||
    (value.protocol > 3 && value.minimumReader === undefined) ||
    !positive(value.environmentEpoch) ||
    !positive(accounts?.sourceMin) ||
    !positive(accounts?.sourceMax) ||
    !positive(accounts?.target) ||
    accounts.sourceMin > accounts.sourceMax ||
    accounts.target < accounts.sourceMax ||
    !positive(policy?.ticket) ||
    !Array.isArray(policy.checks) ||
    new Set(policy.checks).size !== policy.checks.length ||
    !policy.checks.every(key => typeof key === 'string' && /^[a-z][A-Za-z]*$/u.test(key)) ||
    !(current ? ['ci', 'linux', 'upgrade'] : requiredAcceptance).every(key => policy.checks.includes(key)) ||
    (current && policy.checks.some(key => !['ci', 'linux', 'upgrade', 'cleanInstall'].includes(key)))
  )
    throw new Error('Unsupported release compatibility protocol')
  if (compareVersions(manifest.targetVersion, '0.1.13') >= 0 && value.protocol < 3) throw new Error('This release requires capacity-aware upgrade protocol 3')
  if (value.protocol >= 3) {
    if (!['platformArchiveBytes', 'platformExpandedBytes', 'imageDownloadBytes', 'imageExpandedBytes'].every(key => positive(manifest.storage?.[key])))
      throw new Error('Release storage requirements are missing or invalid')
    if (typeof manifest.updater !== 'string' || Buffer.byteLength(manifest.updater) > 16384)
      throw new Error('Release updater inventory is missing or unbounded')
  }
  if (value.minimumReader !== undefined) versionParts(value.minimumReader)
  if (value.schemas !== undefined) {
    if (!Array.isArray(value.schemas) || value.schemas[0]?.name !== 'dsh_phalanx')
      throw new Error('Registered schema compatibility must begin with the platform core')
    const names = new Set()
    for (const row of value.schemas) {
      if (
        !row ||
        typeof row.name !== 'string' ||
        !/^[a-z_][a-z0-9_]{0,62}$/u.test(row.name) ||
        row.name.startsWith('pg_') ||
        ['public', 'information_schema'].includes(row.name) ||
        names.has(row.name) ||
        !Number.isSafeInteger(row.sourceMin) ||
        row.sourceMin < 0 ||
        !Number.isSafeInteger(row.sourceMax) ||
        row.sourceMax < row.sourceMin ||
        !positive(row.target) ||
        row.target < row.sourceMax
      )
        throw new Error('Invalid registered schema compatibility range')
      names.add(row.name)
    }
    if (['sourceMin', 'sourceMax', 'target'].some(key => value.schemas[0][key] !== accounts[key]))
      throw new Error('Legacy accounts must match the platform core compatibility range')
  }
  if (value.upgradeFloor !== undefined && compareVersions(value.upgradeFloor, manifest.targetVersion) >= 0) throw new Error('Invalid upgrade floor')
  if (value.breakpoints !== undefined) {
    if (!Array.isArray(value.breakpoints)) throw new Error('Invalid upgrade breakpoints')
    let previous,
      previousEpoch = 0
    for (const point of value.breakpoints) {
      if (
        !point ||
        compareVersions(point.version, manifest.targetVersion) > 0 ||
        (value.upgradeFloor !== undefined && compareVersions(point.version, value.upgradeFloor) < 0) ||
        (previous !== undefined && compareVersions(point.version, previous) <= 0) ||
        !positive(point.environmentEpoch) ||
        point.environmentEpoch < previousEpoch ||
        point.environmentEpoch > value.environmentEpoch
      )
        throw new Error('Invalid ordered upgrade breakpoints')
      previous = point.version
      previousEpoch = point.environmentEpoch
    }
  }
  const revisions = value.sourceDshRevisions
  if (value.protocol === 2 || (value.protocol >= 3 && Object.hasOwn(value, 'sourceDshRevisions'))) {
    if (
      !Array.isArray(revisions) ||
      revisions.length === 0 ||
      !revisions.every(revision => typeof revision === 'string' && /^[a-f0-9]{40}$/u.test(revision)) ||
      new Set(revisions).size !== revisions.length
    )
      throw new Error('Runtime transition requires exact source DSH revisions')
  } else if (revisions !== undefined) throw new Error('Protocol 1 cannot declare a runtime transition')
  if (
    value.freshInstallThrough !== undefined &&
    (value.protocol < 3 || compareVersions(value.freshInstallThrough, manifest.targetVersion) >= 0 || accounts.sourceMin < 6)
  )
    throw new Error('Invalid fresh-install compatibility boundary')
  if (compareVersions(value.source?.min, value.source?.maxExclusive) >= 0 || compareVersions(value.source.min, manifest.targetVersion) >= 0)
    throw new Error('Invalid upgrade source interval')
}
