// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { it } from 'vitest'
import { verifySharedMcpScenario } from './support/shared-mcp-scenario.js'

it('keeps an installed silent call alive through real idle reclamation and does not replay unknown results after process exit', async () => {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || !process.env.DSH_PHALANX_INSTALL_ROOT || !process.env.DSH_PHALANX_CANDIDATE_SHA || !process.env.DSH_PHALANX_CONTAINER_IMAGE) throw Error('Requires an exact installed candidate and dedicated rootless Linux')
  await verifySharedMcpScenario('installed-lifecycle')
}, 900000)
