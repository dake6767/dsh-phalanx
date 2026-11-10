import { request, skillSynchronizationChanged } from './community-api'

export function communityMcpPublicationImpact(name: string): Promise<import('../../src/domain/admin-contract').CommunityMcpPublicationImpact> {
  return request('/admin/api/mcp?publication=' + encodeURIComponent(name))
}
export function publishCommunitySkillPack(name: string, published: boolean, revision: string): Promise<unknown> {
  return request('/admin/api/skill-packs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'publish', name, published, revision }),
  }).finally(skillSynchronizationChanged)
}
