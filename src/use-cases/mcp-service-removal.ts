import { BusinessRuleError } from '../domain/business-error.js'
import type { McpRemovalImpact } from '../domain/mcp-removal.js'
import type { McpSnapshot, McpStatePort } from '../ports/mcp-services.js'

/** A removal preview binds the service row and its current expert references. */
export class McpServiceRemoval {
  constructor(private readonly store: McpStatePort) {}
  async impact(name: string): Promise<McpRemovalImpact> {
    return (await this.capture(await this.store.read(), name)).impact
  }
  async remove(name: string, revision?: string): Promise<void> {
    const state = await this.store.read()
    if (!state.services.some(row => row.name === name)) return
    const captured = await this.capture(state, name)
    if (revision === undefined ? captured.impact.experts.length > 0 : revision !== captured.impact.revision)
      throw new BusinessRuleError('conflict', 'MCP removal impact changed. Review it again.', 'mcp-impact-changed')
    await this.store.update(
      state,
      {
        ...state,
        selections: Object.fromEntries(Object.entries(state.selections ?? {}).map(([id, names]) => [id, names.filter(value => value !== name)])),
        preferences: Object.fromEntries(
          Object.entries(state.preferences ?? {}).map(([id, values]) => [id, Object.fromEntries(Object.entries(values).filter(([key]) => key !== name))]),
        ),
        revision: Math.max(state.revision ?? 0, ...state.services.map(row => row.generation)),
        services: state.services.filter(row => row.name !== name),
        grants: Object.fromEntries(Object.entries(state.grants).map(([id, names]) => [id, names.filter(value => value !== name)])),
      },
      captured.referenceRevision === undefined ? undefined : { expertReferenceRevision: captured.referenceRevision },
    )
  }
  private async capture(state: McpSnapshot, name: string) {
    if (!state.services.some(row => row.name === name)) throw new BusinessRuleError('missing', 'MCP service was not found.', 'not-found')
    const references = await this.store.expertReferences?.impact([{ kind: 'mcp', name }])
    return {
      impact: { name, experts: references?.experts ?? [], revision: JSON.stringify([name, state.versions.services[name], references?.revision ?? null]) },
      referenceRevision: references?.revision,
    }
  }
}
