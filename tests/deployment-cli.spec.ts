import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { pythonFixtureCases } from './python-fixture-cases.js'

it.each(pythonFixtureCases('deployment-cli'))('public deployment CLI: %s', testCase => {
  const result = spawnSync('python3', ['tests/fixtures/deployment-cli.py', testCase], {
    encoding: 'utf8',
    timeout: 15000,
  })
  expect(result.status, result.error?.message ?? result.stderr).toBe(0)
})

it('refuses initialized, busy, unobservable or foreign storage before privileged lifecycle acceptance can borrow a baseline', () => {
  const result = spawnSync('python3', ['tests/fixtures/deployment-host-safety.py'], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, result.stderr).toBe(0)
})
