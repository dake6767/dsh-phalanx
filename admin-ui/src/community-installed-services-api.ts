import type { CommunityInstalledServices } from '../../src/domain/admin-contract'
import type { InstalledServiceChange, InstalledServiceOwner } from '../../src/domain/installed-services'
import { request } from './community-api'

function installedServicesPath({ kind, name }: InstalledServiceOwner) {
  return (kind === 'execution' ? '/admin/api/skills/execution/services?name=' : '/admin/api/plugins/services?packageName=') + encodeURIComponent(name)
}

export function communityInstalledServices(owner: InstalledServiceOwner, signal?: AbortSignal): Promise<CommunityInstalledServices> {
  return request(installedServicesPath(owner), { signal })
}

export function changeCommunityInstalledServices(
  owner: InstalledServiceOwner,
  revision: string,
  change: InstalledServiceChange,
): Promise<CommunityInstalledServices> {
  return request(installedServicesPath(owner), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision, change }),
  })
}
