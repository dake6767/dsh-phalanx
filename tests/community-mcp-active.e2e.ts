// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { it } from 'vitest'
import { verifySharedMcpScenario } from './support/shared-mcp-scenario.js'

it('keeps active and silent shared calls alive and safely recovers after child exit in the same DSH session', async () => {
  await verifySharedMcpScenario('lifecycle')
}, 300000)
