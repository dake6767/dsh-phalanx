import { request, skillSynchronizationChanged } from './community-api'

export function saveCommunitySkillPack(
  pack: import('../../src/domain/admin-contract').CommunitySkillPackInput,
  revision: string,
  previousName?: string,
): Promise<import('../../src/domain/admin-contract').CommunitySkillPackView> {
  return request<import('../../src/domain/admin-contract').CommunitySkillPackView>('/admin/api/skill-packs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'save', pack, revision, ...(previousName ? { previousName } : {}) }),
  }).finally(skillSynchronizationChanged)
}
export function saveCommunitySkillPackDisplay(name: string, display: { displayName?: string; description?: string }, revision: string): Promise<unknown> {
  return request('/admin/api/skill-packs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'save-display', name, display, revision }),
  }).finally(skillSynchronizationChanged)
}
export function removeCommunitySkillPack(name: string, deleteSkills: boolean, revision: string): Promise<unknown> {
  return request('/admin/api/skill-packs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'remove', name, deleteSkills, revision }),
  }).finally(skillSynchronizationChanged)
}
