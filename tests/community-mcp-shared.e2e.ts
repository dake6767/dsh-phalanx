import { it } from 'vitest'
import { verifySharedMcpScenario } from './support/shared-mcp-scenario.js'

it('runs two private shared MCP sessions through real DSH, rotates credentials and reaps revoked carriers',
  () => verifySharedMcpScenario('management'), 900000)
