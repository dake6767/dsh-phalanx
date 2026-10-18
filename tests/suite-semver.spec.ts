import { expect, it } from 'vitest'
import { compareSemver, compareStrictVersions, parseSemver, parseSemverRange, satisfiesSemverRange } from '../src/domain/semver.js'
import { compareSuiteVersions } from '../src/domain/suite-install.js'

it('parses only strict SemVer 2.0.0 versions', () => {
  expect(parseSemver('0.1.18')).toEqual({ major: 0, minor: 1, patch: 18, prerelease: [] })
  expect(parseSemver('1.2.3-rc.2+build.5')).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: ['rc', '2'] })
  for (const value of ['1', '1.2', 'v1.2.3', '01.2.3', '1.02.3', '1.2.3-', '1.2.3+', '1.2.3.4', ' 1.2.3', '1.2.3-01', '']) expect(parseSemver(value), value).toBeUndefined()
})

it('orders versions by SemVer precedence and ignores build metadata', () => {
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
  for (let index = 1; index < order.length; index++) expect(compareSemver(parseSemver(order[index - 1]!)!, parseSemver(order[index]!)!), order[index]).toBe(-1)
  expect(compareStrictVersions('1.2.3+a', '1.2.3+b')).toBe(0)
  expect(compareStrictVersions('0.1.10', '0.1.9')).toBe(1)
  expect(compareStrictVersions('1', '1.0.0')).toBeUndefined()
})

it('satisfies caret, tilde, comparator, wildcard, hyphen and union ranges', () => {
  expect(satisfiesSemverRange('0.1.19', '>=0.1.18')).toBe(true)
  expect(satisfiesSemverRange('0.1.17', '>=0.1.18')).toBe(false)
  expect(satisfiesSemverRange('1.4.0', '^1.2.3')).toBe(true)
  expect(satisfiesSemverRange('2.0.0', '^1.2.3')).toBe(false)
  expect(satisfiesSemverRange('0.2.5', '^0.2.3')).toBe(true)
  expect(satisfiesSemverRange('0.3.0', '^0.2.3')).toBe(false)
  expect(satisfiesSemverRange('1.2.9', '~1.2.3')).toBe(true)
  expect(satisfiesSemverRange('1.3.0', '~1.2.3')).toBe(false)
  expect(satisfiesSemverRange('1.2.3', '1.2.3')).toBe(true)
  expect(satisfiesSemverRange('1.2.4', '1.2.3')).toBe(false)
  expect(satisfiesSemverRange('1.9.0', '1.x')).toBe(true)
  expect(satisfiesSemverRange('2.0.0', '1.x')).toBe(false)
  expect(satisfiesSemverRange('1.2.8', '1.2.x')).toBe(true)
  expect(satisfiesSemverRange('1.3.0', '1.2.x')).toBe(false)
  expect(satisfiesSemverRange('1.5.0', '>=1.2.0 <2.0.0')).toBe(true)
  expect(satisfiesSemverRange('2.0.0', '>=1.2.0 <2.0.0')).toBe(false)
  expect(satisfiesSemverRange('1.4.0', '1.2.3 - 1.5.0')).toBe(true)
  expect(satisfiesSemverRange('1.6.0', '1.2.3 - 1.5.0')).toBe(false)
  expect(satisfiesSemverRange('2.1.0', '^1.2.3 || ^2.0.0')).toBe(true)
  expect(satisfiesSemverRange('0.1.18', '*')).toBe(true)
})

it('requires a matching prerelease comparator for prerelease versions', () => {
  expect(satisfiesSemverRange('0.2.0-rc.1', '>=0.2.0-rc.0')).toBe(true)
  expect(satisfiesSemverRange('0.2.0-rc.1', '>=0.1.0')).toBe(false)
  expect(satisfiesSemverRange('0.2.0-rc.1', '>=0.2.0-rc.0 <0.2.0')).toBe(true)
})

it('rejects malformed ranges', () => {
  for (const range of ['', 'latest', '>=', '~', '^', '1.2.3 <', '1.2.3 || ', 'garbage', '>=1.2.3-']) expect(parseSemverRange(range), range).toBeUndefined()
})

it('keeps legacy short records comparable while strict pairs use SemVer precedence', () => {
  expect(compareSuiteVersions('1', '2')).toBeLessThan(0)
  expect(compareSuiteVersions('10', '9')).toBeGreaterThan(0)
  expect(compareSuiteVersions('1', '1.0.0')).toBe(0)
  expect(compareSuiteVersions('1.2', '1.2.0')).toBe(0)
  expect(compareSuiteVersions('2', '1.10.0')).toBeGreaterThan(0)
  expect(compareSuiteVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
  expect(compareSuiteVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
  expect(compareSuiteVersions('0.1.10', '0.1.9')).toBeGreaterThan(0)
  expect(compareSuiteVersions('1.0.0', '1.0.0')).toBe(0)
})

it('accepts the npm range forms a catalog entry may declare', () => {
  const cases: readonly [string, string, string][] = [
    ['^0.1.19', '0.1.20', '0.2.0'],
    ['~0.1.19', '0.1.20', '0.2.0'],
    ['>=0.1.19', '0.1.19', '0.1.18'],
    ['>=0.1.19 <0.2.0', '0.1.25', '0.2.0'],
    ['<0.2', '0.1.99', '0.2.0'],
    ['1.2.x', '1.2.7', '1.3.0'],
    ['*', '9.9.9', 'invalid'],
  ]
  for (const [range, accepted, rejected] of cases) {
    expect(parseSemverRange(range), range).toBeDefined()
    expect(satisfiesSemverRange(accepted, range), `${range} accepts ${accepted}`).toBe(true)
    expect(satisfiesSemverRange(rejected, range), `${range} rejects ${rejected}`).toBe(false)
  }
  expect(satisfiesSemverRange('9.9.9', '*')).toBe(true)
  expect(satisfiesSemverRange('0.0.0', '*')).toBe(true)
})
