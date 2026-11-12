import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('previews a noninteractive LAN installation without host changes and keeps machine output structured', () => {
  const result = spawnSync(
    'python3',
    ['scripts/install/preview.py', 'install', '--non-interactive', '--server-ip', '192.0.2.10', '--host-public-addresses', '', '--output', 'json'],
    { encoding: 'utf8' },
  )
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({
    simulation: true,
    changed: false,
    command: 'install',
    status: 'succeeded',
    configuration: { source: 'official', port: '18080', origin: 'http://192.0.2.10:18080', mapping: '' },
  })
})

it('rehearses bilingual terminal correction, summaries, cancellation, stage failures and management commands', () => {
  const result = spawnSync('python3', ['tests/fixtures/installer-preview.py'], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, result.stderr).toBe(0)
})
