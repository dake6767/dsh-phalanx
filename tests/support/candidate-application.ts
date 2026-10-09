import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommunityConfig } from '../../src/domain/community-config.js'
import { createCommunityApplication } from '../../src/composition/community-application.js'
import { upgradeApplication } from './upgrade-application.js'

/** Final Linux validation uses the exact installed candidate through its public CLI. */
export function candidateApplication(config: CommunityConfig, startupTimeoutMs = 30_000) {
  const installed = process.env.DSH_PHALANX_INSTALL_ROOT
  if (installed === undefined || config.runtime.container === undefined) return createCommunityApplication(config)
  const build = JSON.parse(readFileSync(join(installed, 'build-info.json'), 'utf8')) as { commit: string; platform: string }
  const expected = process.env.DSH_PHALANX_CANDIDATE_SHA
  if (expected === undefined || build.commit !== expected || build.platform !== 'linux/amd64') throw new Error('Installed candidate identity mismatch')
  return upgradeApplication(config, installed, startupTimeoutMs)
}
