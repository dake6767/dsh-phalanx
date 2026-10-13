import { it } from 'vitest'
import { verifySharedMcpScenario } from './support/shared-mcp-scenario.js'

it('recovers two real DSH sessions after shared MCP idle reclamation without restarting member instances',
  () => verifySharedMcpScenario('recovery'), 900000)
