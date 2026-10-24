/** Exact PyPI pins follow the PyPA version-specifier grammar, including two-part releases.
 * https://packaging.python.org/en/latest/specifications/version-specifiers/
 */
const versionPattern = /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d+)?)?(?:(?:-(\d+))|(?:[-_.]?(post|rev|r)[-_.]?(\d+)?))?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$/iu
const integer = (value: string) => BigInt(value).toString()
export function pythonPackagePin(value: string): { name: string, version: string, identity: string } | undefined {
  const pin = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)==(.+)$/u.exec(value.trim())
  if (!pin || pin[1]!.length > 128 || pin[2]!.length > 128) return undefined
  const parsed = versionPattern.exec(pin[2]!)
  if (!parsed) return undefined
  const [, epoch, release, pre, preNumber, postNumber, post, explicitPostNumber, dev, devNumber, local] = parsed
  const name = pin[1]!.toLowerCase().replace(/[-_.]+/gu, '-')
  const numbers = release!.split('.').map(integer)
  const prefix = epoch && integer(epoch) !== '0' ? integer(epoch) + '!' : ''
  const preLabel = pre ? ({ alpha: 'a', beta: 'b', c: 'rc', pre: 'rc', preview: 'rc' } as Record<string, string>)[pre.toLowerCase()] ?? pre.toLowerCase() : ''
  const suffix = (pre ? preLabel + integer(preNumber ?? '0') : '')
    + (postNumber !== undefined || post ? '.post' + integer(postNumber ?? explicitPostNumber ?? '0') : '')
    + (dev ? '.dev' + integer(devNumber ?? '0') : '')
    + (local ? '+' + local.toLowerCase().split(/[-_.]/u).map(part => /^\d+$/u.test(part) ? integer(part) : part).join('.') : '')
  const version = prefix + numbers.join('.') + suffix
  while (numbers.length > 1 && numbers.at(-1) === '0') numbers.pop()
  return { name, version, identity: prefix + numbers.join('.') + suffix }
}

/** A lock lists every package explicitly; ranges, URLs, markers and conflicting aliases are rejected. */
export function pythonPackagePins(values: unknown): readonly string[] | undefined {
  if (!Array.isArray(values) || !values.length || values.length > 512) return undefined
  const pins = new Map<string, { version: string, identity: string }>()
  for (const value of values) {
    const pin = typeof value === 'string' ? pythonPackagePin(value) : undefined
    if (!pin || pins.has(pin.name) && pins.get(pin.name)!.identity !== pin.identity) return undefined
    pins.set(pin.name, pin)
  }
  const result = [...pins].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, pin]) => `${name}==${pin.version}`)
  return result.join(' ').length <= 100 * 1024 ? result : undefined
}

export function pythonLibraryPreparation(packages: readonly string[]): string {
  return ['set -eu', 'python3 -m venv --copies "$RD_OUT/venv"',
    '"$RD_OUT/venv/bin/python3" -m pip install --disable-pip-version-check --no-input --no-cache-dir --only-binary=:all: --no-deps ' + packages.map(pin => `'${pin}'`).join(' '),
    '"$RD_OUT/venv/bin/python3" -m pip check'].join('\n')
}
