import type { McpState, McpService } from '../../src/domain/mcp-service.js'
import type { McpSnapshot, McpStatePort } from '../../src/ports/mcp-services.js'

interface MemoryMcpFacts {
  read(): McpState
  write?(state: McpState): void | Promise<void>
  version?(): number
}
const payload = (state: McpState): McpState => ({
  services: state.services,
  grants: state.grants,
  ...(state.revision === undefined ? {} : { revision: state.revision }),
  ...(state.catalogRequests === undefined ? {} : { catalogRequests: state.catalogRequests }),
  ...(state.selections === undefined ? {} : { selections: state.selections }),
  ...(state.preferences === undefined ? {} : { preferences: state.preferences }),
})

/** Promise boundaries for pure policy fixtures. Atomic SQL and publication guarantees belong to the real PG suites. */
export function asyncMcpFacts(facts: MemoryMcpFacts): McpStatePort {
  const snapshot = (): McpSnapshot => {
    const state = structuredClone(payload(facts.read()))
    return {
      ...state,
      protectedRevision: 'memory-fixture',
      versions: {
        services: Object.fromEntries(state.services.map(row => [row.name, JSON.stringify(row)])),
        groups: Object.fromEntries(Object.entries(state.grants).map(([id, names]) => [id, JSON.stringify(names)])),
        members: Object.fromEntries(
          [...new Set([...Object.keys(state.selections ?? {}), ...Object.keys(state.preferences ?? {})])].map(id => [
            id,
            JSON.stringify([state.selections?.[id], state.preferences?.[id]]),
          ]),
        ),
      },
    }
  }
  const save = async (state: McpState) => {
    if (!facts.write) throw Error('Read-only MCP fixture')
    await facts.write(payload(state))
  }
  return {
    view: { read: snapshot, version: () => JSON.stringify([facts.version?.(), snapshot()]) },
    read: async () => snapshot(),
    update: async (_previous, state) => save(state),
    reconcile: async runtime => {
      if (!runtime?.configure) return
      const state = snapshot(),
        services: McpService[] = []
      for (const row of state.services) {
        const current = await runtime.configure(row)
        services.push(
          current.catalogUpdate?.candidate
            ? { ...current, catalogUpdate: { ...current.catalogUpdate, candidate: await runtime.configure(current.catalogUpdate.candidate) } }
            : current,
        )
      }
      if (JSON.stringify(services) !== JSON.stringify(state.services)) await save({ ...state, services })
    },
  }
}
