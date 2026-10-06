import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('shares fixed release preparation, transaction and verified recovery through the public upgrade seam', () => {
  const result = spawnSync('python3', ['tests/fixtures/upgrade-core.py'], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, result.stderr).toBe(0)
})
