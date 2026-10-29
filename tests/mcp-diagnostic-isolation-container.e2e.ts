// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { it } from 'vitest'
import { verifyMcpDiagnosticIsolation } from './support/mcp-diagnostic-isolation.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision } from './support/real-dsh-runtime.js'

it.skipIf(!runtimeSettings.containerImage)(
  'keeps a rootless member MCP session usable after administrator diagnostics close',
  async () => {
    assertPinnedDshRevision(runtimeSettings)
    await verifyMcpDiagnosticIsolation(runtimeSettings)
  },
  120000,
)
