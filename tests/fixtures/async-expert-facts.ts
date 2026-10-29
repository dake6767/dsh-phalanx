import type { ExpertState } from '../../src/domain/expert.js'
import type { ExpertSnapshot, ExpertStorePort } from '../../src/ports/experts.js'

interface MemoryExpertFacts {
  read(): ExpertState
  write(state: ExpertState): void | Promise<void>
}

/** Pure policy fixture only; actual row CAS, SQL atomicity and publication use the real PostgreSQL suites. */
export function asyncExpertFacts(facts: MemoryExpertFacts): ExpertStorePort {
  const snapshot = (): ExpertSnapshot => {
    const state = structuredClone(facts.read())
    return {
      ...state,
      parentRevision: 'pure-policy-fixture',
      publicRevision: JSON.stringify(state),
      versions: {
        experts: Object.fromEntries(state.experts.map(row => [row.id, JSON.stringify(row)])),
        groups: Object.fromEntries(Object.entries(state.grants).map(([id, names]) => [id, JSON.stringify(names)])),
        members: Object.fromEntries(Object.entries(state.selections).map(([id, names]) => [id, JSON.stringify(names)])),
      },
    }
  }
  return {
    view: { read: snapshot, version: () => snapshot().publicRevision },
    read: async () => snapshot(),
    update: async (_previous, next) => {
      const { experts, grants, selections, revision } = next
      await facts.write({ experts, grants, selections, revision })
    },
  }
}
