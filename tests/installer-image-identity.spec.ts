import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('verifies independent image identities through installer and updater public commands', () => {
  const result = spawnSync('python3', ['tests/fixtures/installer-image-identity.py'], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, result.stderr).toBe(0)
}, 30000)
