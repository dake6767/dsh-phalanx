import { it } from 'vitest'
import { verifyMcpDiagnosticIsolation } from './support/mcp-diagnostic-isolation.js'

it('keeps the administrator member session usable after connection diagnostics close', () => verifyMcpDiagnosticIsolation())
