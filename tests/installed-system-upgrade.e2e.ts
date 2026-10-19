// Validation: T4 isolated host; real credentials: SSH access to the owned validation VM; a provider key for the post-upgrade reply. Never run on a live deployment.
import { it } from 'vitest'
import { execFileText } from '../src/adapters/runtime-command.js'
import { runInstalledUpgrade } from './support/installed-upgrade-scenario.js'

it('upgrades the formal installed OS service while preserving manual MCP grants, selections and member data', async () => {
  const origin = process.env.DSH_PHALANX_OS_ORIGIN, address = process.env.DSH_PHALANX_OS_FIXTURE_ADDRESS
  const ssh = JSON.parse(process.env.DSH_PHALANX_OS_SSH_ARGS ?? 'null') as string[] | null
  const bundle = process.env.DSH_PHALANX_OS_BUNDLE, installer = process.env.DSH_PHALANX_OS_INSTALLER
  const releaseBundle = process.env.DSH_PHALANX_OS_RELEASE_BUNDLE
  const candidate = process.env.DSH_PHALANX_CANDIDATE_SHA, tag = process.env.DSH_PHALANX_CANDIDATE_TAG
  if (!origin || !address || !ssh?.length || !candidate || !tag || !/^run-[1-9]\d*$/u.test(tag) || !bundle || !installer || !releaseBundle || ![bundle, installer].every(path => /^\/[a-zA-Z0-9/_.-]+$/u.test(path))) throw Error('Requires an isolated formal baseline VM, exact candidate bundle and protected SSH configuration')
  const remote = async (command: string, timeout = 120000, acceptedExitCodes = [0]) => {
    try { return await execFileText('ssh', [...ssh, `cd / && ${command}`], { timeout, maxBuffer: 4 * 1024 * 1024, acceptedExitCodes }) }
    catch (error) {
      if (error instanceof Error && 'killed' in error && error.killed === true) throw new Error(`Acceptance SSH command exceeded its ${timeout}ms budget: ${String(error)}`)
      throw error
    }
  }
  await runInstalledUpgrade({ origin, address, remote, bundle, installer, releaseBundle, candidate, tag, realReply: true })
}, 5400000)
