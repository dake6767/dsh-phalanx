import { expect, it } from 'vitest'
import { harnessReusePlan } from '../scripts/release/harness-reuse.mjs'

const tree = (files: Record<string, string>) => ({
  truncated: false,
  tree: Object.entries(files).map(([path, sha]) => ({ path, sha: sha.repeat(40), type: 'blob', mode: '100644' })),
})
it('reuses bytes for receipt-only changes and selects only the affected Harness stages', () => {
  const original = tree({ 'src/main.ts': 'a', 'tests/example.spec.ts': 'b', 'tests/installed-formal-upgrade.e2e.ts': 'c' })
  const receipt = tree({
    'src/main.ts': 'a',
    'tests/example.spec.ts': 'b',
    'tests/installed-formal-upgrade.e2e.ts': 'c',
    'releases/acceptance/0.1.24.json': 'd',
  })
  expect(harnessReusePlan(original, receipt).checks).toEqual([])
  expect(harnessReusePlan(original, receipt).inputDigest).toBe(harnessReusePlan(original, original).inputDigest)
  const spec = tree({ 'src/main.ts': 'a', 'tests/example.spec.ts': 'e', 'tests/installed-formal-upgrade.e2e.ts': 'c' })
  expect(harnessReusePlan(original, spec).checks).toEqual(['ci'])
  const upgrade = tree({ 'src/main.ts': 'a', 'tests/example.spec.ts': 'b', 'tests/installed-formal-upgrade.e2e.ts': 'e' })
  expect(harnessReusePlan(original, upgrade).checks).toEqual(['ci', 'upgrade'])
  const shared = tree({ 'src/main.ts': 'a', 'tests/example.spec.ts': 'b', 'tests/installed-formal-upgrade.e2e.ts': 'c', 'tests/support/process.ts': 'f' })
  expect(harnessReusePlan(original, shared).checks).toEqual(['ci', 'linux', 'upgrade'])
  expect(harnessReusePlan(original, shared, ['ci', 'linux', 'upgrade', 'cleanInstall']).checks).toEqual(['ci', 'cleanInstall', 'linux', 'upgrade'])
  expect(() => harnessReusePlan(original, tree({ 'src/main.ts': 'f' }))).toThrow('rebuild required')
  expect(() => harnessReusePlan(original, { ...receipt, truncated: true })).toThrow('Complete source tree')
})
