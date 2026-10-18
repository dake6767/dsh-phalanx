/** Strict Semantic Versioning 2.0.0 values, comparison and ranges. */
export interface SemverVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** Dot-separated prerelease identifiers; empty for a release version. */
  readonly prerelease: readonly string[]
}

export interface SemverComparator {
  readonly operator: '>' | '>=' | '<' | '<=' | '='
  readonly version: SemverVersion
}

/** One conjunction of comparators; a range is a disjunction of these sets. */
export type SemverComparatorSet = readonly SemverComparator[]

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u
const partialPattern = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*|\*|x|X)(?:\.(0|[1-9]\d*|\*|x|X))?)?$/u

export function parseSemver(value: string): SemverVersion | undefined {
  const match = versionPattern.exec(value)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ? match[4].split('.') : [] }
}

export function formatSemver(value: SemverVersion): string {
  return `${value.major}.${value.minor}.${value.patch}${value.prerelease.length ? `-${value.prerelease.join('.')}` : ''}`
}

const numeric = (value: string): boolean => /^\d+$/u.test(value)

/** Precedence per SemVer 2.0.0 §11; build metadata never affects it. */
export function compareSemver(left: SemverVersion, right: SemverVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  const a = left.prerelease, b = right.prerelease
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const one = a[index], other = b[index]
    if (one === undefined) return -1
    if (other === undefined) return 1
    if (one === other) continue
    const oneNumeric = numeric(one), otherNumeric = numeric(other)
    if (oneNumeric && otherNumeric) return Number(one) < Number(other) ? -1 : 1
    if (oneNumeric) return -1
    if (otherNumeric) return 1
    return one < other ? -1 : 1
  }
  return 0
}

/** Compares two strict versions; undefined when either side is not strict SemVer. */
export function compareStrictVersions(left: string, right: string): number | undefined {
  const a = parseSemver(left), b = parseSemver(right)
  return a && b ? compareSemver(a, b) : undefined
}

const release = (major: number, minor: number, patch: number): SemverVersion => ({ major, minor, patch, prerelease: [] })

/** Parses `^`, `~`, wildcard, hyphen, comparator and `||` ranges; undefined when malformed. */
export function parseSemverRange(range: string): readonly SemverComparatorSet[] | undefined {
  if (typeof range !== 'string' || range.trim() === '') return undefined
  const sets: SemverComparatorSet[] = []
  for (const part of range.split('||')) {
    if (part.trim() === '') return undefined
    const set = parseComparatorSet(part.trim())
    if (!set) return undefined
    sets.push(set)
  }
  return sets.length ? sets : undefined
}

function parseComparatorSet(text: string): SemverComparatorSet | undefined {
  if (text === '' || text === '*' || text === 'x' || text === 'X') return []
  const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(text)
  if (hyphen) {
    const low = parseSemver(hyphen[1]!), high = parseSemver(hyphen[2]!)
    return low && high ? [{ operator: '>=', version: low }, { operator: '<=', version: high }] : undefined
  }
  const comparators: SemverComparator[] = []
  for (const token of text.split(/\s+/u)) {
    const parsed = parseComparatorToken(token)
    if (!parsed) return undefined
    comparators.push(...parsed)
  }
  return comparators
}

function parseComparatorToken(token: string): readonly SemverComparator[] | undefined {
  if (token.startsWith('^')) {
    const base = parseSemver(token.slice(1))
    if (!base) return undefined
    const upper = base.major > 0 ? release(base.major + 1, 0, 0) : base.minor > 0 ? release(0, base.minor + 1, 0) : release(0, 0, base.patch + 1)
    return [{ operator: '>=', version: base }, { operator: '<', version: upper }]
  }
  if (token.startsWith('~')) {
    const base = parseSemver(token.slice(1))
    if (!base) return undefined
    return [{ operator: '>=', version: base }, { operator: '<', version: release(base.major, base.minor + 1, 0) }]
  }
  const match = /^(>=|<=|>|<|=)?(.+)$/u.exec(token)
  if (!match) return undefined
  const operator = (match[1] ?? '=') as SemverComparator['operator']
  const value = match[2]!
  const exact = parseSemver(value)
  if (exact) return [{ operator, version: exact }]
  const partial = partialPattern.exec(value)
  if (!partial) return undefined
  return wildcardComparators(operator, partial)
}

/** npm-style partial versions: `1`, `1.2`, `1.x`, `1.2.x` become a bounded interval; comparators bind to it. */
function wildcardComparators(operator: SemverComparator['operator'], partial: RegExpExecArray): readonly SemverComparator[] | undefined {
  const major = Number(partial[1])
  const minorText = partial[2], patchText = partial[3]
  const isWildcard = (value: string | undefined): boolean => value === undefined || value === '*' || value === 'x' || value === 'X'
  const bounds = (lower: SemverVersion, upper: SemverVersion): readonly SemverComparator[] | undefined => {
    switch (operator) {
      case '=': return [{ operator: '>=', version: lower }, { operator: '<', version: upper }]
      case '>=': return [{ operator: '>=', version: lower }]
      case '>': return [{ operator: '>=', version: upper }]
      case '<': return [{ operator: '<', version: lower }]
      case '<=': return [{ operator: '<', version: upper }]
      default: return undefined
    }
  }
  if (isWildcard(minorText)) return bounds(release(major, 0, 0), release(major + 1, 0, 0))
  if (isWildcard(patchText)) return bounds(release(major, Number(minorText), 0), release(major, Number(minorText) + 1, 0))
  return undefined
}

/** Treats legacy short versions (`1`, `1.2`) as 1.0.0 / 1.2.0 for comparison during the bundled-entry transition. */
export function coerceLegacyVersion(value: string): SemverVersion | undefined {
  const strict = parseSemver(value)
  if (strict) return strict
  const match = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?$/u.exec(value)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0), prerelease: [] }
}

const prereleaseTuple = (version: SemverVersion): string => `${version.major}.${version.minor}.${version.patch}`

function satisfiesComparator(version: SemverVersion, comparator: SemverComparator): boolean {
  const order = compareSemver(version, comparator.version)
  switch (comparator.operator) {
    case '>': return order > 0
    case '>=': return order >= 0
    case '<': return order < 0
    case '<=': return order <= 0
    default: return order === 0
  }
}

/** True when a strict version satisfies every comparator of at least one range set. */
export function satisfiesSemverRange(version: string, range: string): boolean {
  const target = parseSemver(version)
  if (!target) return false
  // Node-style prune: a prerelease only matches a set that also admits a prerelease of the same tuple.
  if (target.prerelease.length) {
    const sets = parseSemverRange(range)
    if (!sets) return false
    return sets.some(set => set.every(comparator => satisfiesComparator(target, comparator))
      && set.some(comparator => comparator.version.prerelease.length > 0 && prereleaseTuple(comparator.version) === prereleaseTuple(target)))
  }
  const sets = parseSemverRange(range)
  return sets !== undefined && sets.some(set => set.every(comparator => satisfiesComparator(target, comparator)))
}

/** Validates a strict SemVer version string. */
export function isStrictSemver(value: string): boolean {
  return parseSemver(value) !== undefined
}
