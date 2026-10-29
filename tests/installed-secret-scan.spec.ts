import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('scans actual file bytes across chunks and resolves only owned runtime projection targets', () => {
  const result = spawnSync('python3', ['tests/fixtures/installed-secret-scan.py'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    representations: 4,
    crossChunkMatches: 4,
    cleanFile: true,
    runtimeTargetScanned: true,
    invalidTargetsRejected: 3,
    unknownAliasNotAccepted: true,
  })
})
