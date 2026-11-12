import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('observes and controls the deployment through its public CLI without changing ownership, autostart or retained data', () => {
  const result = spawnSync('python3', ['tests/fixtures/deployment-cli.py'], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, result.stderr).toBe(0)
})

it('refuses initialized, busy, unobservable or foreign storage before privileged lifecycle acceptance can borrow a baseline', () => {
  const result = spawnSync('python3', ['tests/fixtures/deployment-host-safety.py'], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, result.stderr).toBe(0)
})
