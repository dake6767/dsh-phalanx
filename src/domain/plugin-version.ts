/** SemVer precedence ignores build metadata and orders numeric prereleases numerically. */
export function newerPluginVersion(candidate: string, installed: string): boolean {
  const parse = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value)
  const next = parse(candidate); const current = parse(installed)
  if (!next || !current) return false
  for (const index of [1, 2, 3]) {
    const a = BigInt(next[index]!); const b = BigInt(current[index]!)
    if (a !== b) return a > b
  }
  if (next[4] === undefined || current[4] === undefined) return next[4] === undefined && current[4] !== undefined
  const a = next[4].split('.'); const b = current[4].split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index]; const right = b[index]
    if (left === right) continue
    if (left === undefined || right === undefined) return right === undefined
    const numericLeft = /^\d+$/u.test(left); const numericRight = /^\d+$/u.test(right)
    if (numericLeft && numericRight) return BigInt(left) > BigInt(right)
    if (numericLeft !== numericRight) return numericRight
    return left > right
  }
  return false
}
