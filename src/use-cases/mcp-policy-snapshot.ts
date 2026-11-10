import type { McpService } from '../domain/mcp-service.js'
import type { McpSnapshot } from '../ports/mcp-services.js'

/** Display edits change storage revisions, but not admission or credential identity. */
export function mcpPolicySnapshot(state: McpSnapshot) {
  const serviceFacts = (service: McpService): Omit<McpService, 'display' | 'rowRevision'> => {
    const { display, rowRevision, ...facts } = service
    void display
    void rowRevision
    return {
      ...facts,
      ...(facts.catalogUpdate?.candidate
        ? {
            catalogUpdate: { ...facts.catalogUpdate, candidate: serviceFacts(facts.catalogUpdate.candidate) },
          }
        : {}),
    }
  }
  const { services, ...policyVersions } = state.versions
  void services
  return { ...state, services: state.services.map(serviceFacts), versions: policyVersions }
}
