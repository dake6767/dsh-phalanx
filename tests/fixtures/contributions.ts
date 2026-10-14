import type { ContributionStore, ContributionAdoptionIntent, ContributionAdoption } from '../../src/ports/member-contributions.js'
import type { MemberContribution } from '../../src/domain/member-contribution.js'
export function memoryContributions(rows = new Map<string, MemberContribution>()): ContributionStore {
  let intent: ContributionAdoptionIntent | undefined
  return { list: () => [...rows.values()], save: row => { rows.set(row.id, row) }, remove: id => { rows.delete(id) },
    intent: () => intent, begin: value => { intent = value }, finish: next => { rows.clear(); for (const row of next) rows.set(row.id, row); intent = undefined } }
}
export function fakeContributionLibrary(onConfirm = () => {}): ContributionAdoption {
  let adopted = false
  return { upload: async () => ({ token: 'preview', name: 'team-guide', description: 'Guide', markdown: '# Guide', files: ['SKILL.md'], replacing: false, revision: 'impact', managedMembers: 0, selectedMembers: 0 }),
    confirm: async () => { onConfirm(); adopted = true; return { name: 'team-guide', description: 'Guide', hash: 'artifact', importedAt: 0, published: false, managedMembers: 0, selectedMembers: 0 } }, adopted: () => adopted }
}
