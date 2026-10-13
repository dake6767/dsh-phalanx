import { it } from 'vitest'
import { verifySharedMcpScenario } from './support/shared-mcp-scenario.js'

it('keeps active and silent shared calls alive and safely recovers after child exit in the same DSH session', async () => {
  await verifySharedMcpScenario('lifecycle')
}, 300000)
