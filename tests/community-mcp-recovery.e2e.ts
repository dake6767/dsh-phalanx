// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { it } from 'vitest'
import { verifySharedMcpScenario } from './support/shared-mcp-scenario.js'

it('recovers two real DSH sessions after shared MCP idle reclamation without restarting member instances',
  () => verifySharedMcpScenario('recovery'), 900000)
