import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { formalUpgradeScope } from '../scripts/validation/formal-baseline.mjs'

const records = ['0.1.9.json', '0.1.10.json', '0.1.18.json', '0.1.18.md', '0.1.19.json', '0.1.19.md', '0.1.7-web.json', '0.1.12-local.md']

it('upgrades from the newest formal record once the version has moved past it', () => {
  expect(formalUpgradeScope(records, '0.1.20', { min: '0.1.19', maxExclusive: '0.1.20' })).toEqual({ target: '0.1.20', previous: '0.1.19', upgrade: true })
  // Before the version bump there is no formal previous to upgrade from.
  expect(formalUpgradeScope(records, '0.1.19', { min: '0.1.18', maxExclusive: '0.1.19' })).toEqual({ target: '0.1.19', previous: '0.1.19', upgrade: false })
  expect(formalUpgradeScope(['0.1.10.json', '0.1.9.json'], '0.1.11', { min: '0.1.10', maxExclusive: '0.1.11' })).toMatchObject({ previous: '0.1.10', upgrade: true })
  expect(formalUpgradeScope(['0.1.7-web.json'], '0.1.8', { min: '0.1.7', maxExclusive: '0.1.8' })).toEqual({ target: '0.1.8', previous: undefined, upgrade: false })
})

it('refuses a previous formal release outside the declared upgrade source', () => {
  // A stale policy interval must fail rather than silently test an older baseline.
  expect(() => formalUpgradeScope(records, '0.1.20', { min: '0.1.18', maxExclusive: '0.1.19' })).toThrow('outside the declared upgrade source 0.1.18..0.1.19')
  expect(() => formalUpgradeScope(records, '0.1.20', { min: '0.1.20', maxExclusive: '0.1.21' })).toThrow('outside the declared upgrade source')
  expect(() => formalUpgradeScope(records, '0.1.20-rc.1', { min: '0.1.19', maxExclusive: '0.1.20' })).toThrow('Invalid release version')
})

it('reports the scope of this checkout for the workflow condition', () => {
  const result = spawnSync(process.execPath, ['scripts/validation/formal-baseline.mjs'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ upgrade: expect.any(Boolean) })
})
