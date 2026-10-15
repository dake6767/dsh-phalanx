import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommunityConfig } from '../../src/domain/community-config.js'
import { createCommunityApplication } from '../../src/composition/community-application.js'
import { validationDownloadSelection } from './validation-downloads.js'
import { upgradeApplication } from './upgrade-application.js'

/** Final Linux validation uses the exact installed candidate through its public CLI. */
export function candidateApplication(config: CommunityConfig, startupTimeoutMs = 30_000) {
  config = { ...config, downloadSources: config.downloadSources ?? validationDownloadSelection() }
  const inventory = process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES
  const configured = config.network !== undefined || inventory === undefined ? config
    : { ...config, network: { hostPublicAddresses: inventory.trim() === '' ? [] : inventory.split(',').map(value => value.trim()) } }
  const installed = process.env.DSH_PHALANX_INSTALL_ROOT
  if (installed === undefined || config.runtime.container === undefined) return createCommunityApplication(configured)
  const build = JSON.parse(readFileSync(join(installed, 'build-info.json'), 'utf8')) as { commit: string; platform: string }
  const expected = process.env.DSH_PHALANX_CANDIDATE_SHA
  const platform = process.platform === 'linux' && process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'
  if (expected === undefined || build.commit !== expected || build.platform !== platform) throw new Error('Installed candidate identity mismatch')
  return upgradeApplication(configured, installed, startupTimeoutMs)
}
