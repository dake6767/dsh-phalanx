import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('attempts remaining owned cleanup when the Linux storage command fails', () => {
  const result = spawnSync('python3', ['tests/fixtures/t2-cleanup.py'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
})
