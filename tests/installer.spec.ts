import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('honors the installation command contract at filesystem and operating-system I/O', () => {
  const result = spawnSync('python3', ['tests/fixtures/installer-contract.py'], { encoding: 'utf8' })
  expect(result.stderr, result.stdout).not.toContain('Traceback')
  expect(result.status, result.stderr).toBe(0)
})
