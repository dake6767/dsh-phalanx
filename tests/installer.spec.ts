import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('honors the installation command contract at filesystem and operating-system I/O', () => {
  const result = spawnSync('python3', ['tests/fixtures/installer-contract.py'], { encoding: 'utf8' })
  expect(result.stderr, result.stdout).not.toContain('Traceback')
  expect(result.status, result.stderr).toBe(0)
})

it('guides retries and preserves terminal input with heredoc source', () => {
  const result = spawnSync('python3', ['tests/fixtures/installer-experience.py'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
})

it('shows live progress and keeps machine output and diagnostics safe', () => {
  const result = spawnSync('python3', ['tests/fixtures/installer-output.py'], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, result.stderr).toBe(0)
})
