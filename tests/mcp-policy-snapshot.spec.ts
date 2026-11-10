import { expect, it } from 'vitest'
import type { McpSnapshot } from '../src/ports/mcp-services.js'
import { mcpPolicySnapshot } from '../src/use-cases/mcp-policy-snapshot.js'

it('keeps display storage revisions outside admission while preserving runtime, credential and member policy facts', () => {
  const state: McpSnapshot = {
    services: [{ name: 'p-docs', description: '', url: 'https://example.test/mcp', generation: 1, rowRevision: 'row-before', published: true }],
    grants: { team: ['p-docs'] },
    selections: { member: ['p-docs'] },
    protectedRevision: 'credential-before',
    versions: { services: { 'p-docs': 'row-before' }, groups: { team: 'group-before' }, members: { member: 'member-before' } },
  }
  const original = mcpPolicySnapshot(state)
  expect(
    mcpPolicySnapshot({
      ...state,
      services: [{ ...state.services[0]!, display: { name: '文档' }, rowRevision: 'row-after' }],
      versions: { ...state.versions, services: { 'p-docs': 'row-after' } },
    }),
  ).toEqual(original)
  for (const changed of [
    { ...state, protectedRevision: 'credential-after' },
    { ...state, services: [{ ...state.services[0]!, generation: 2 }] },
    { ...state, services: [{ ...state.services[0]!, url: 'https://changed.example.test/mcp' }] },
    { ...state, grants: { team: [] } },
    { ...state, selections: { member: [] } },
    { ...state, versions: { ...state.versions, groups: { team: 'group-after' } } },
    { ...state, versions: { ...state.versions, members: { member: 'member-after' } } },
  ])
    expect(mcpPolicySnapshot(changed)).not.toEqual(original)
})
