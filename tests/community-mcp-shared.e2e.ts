// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { it } from 'vitest'
import { verifySharedMcpScenario } from './support/shared-mcp-scenario.js'

it('runs two private shared MCP sessions through real DSH, rotates credentials and reaps revoked carriers', () => verifySharedMcpScenario('management'), 900000)
