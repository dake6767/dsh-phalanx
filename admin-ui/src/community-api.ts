import type { CommunityMcpAction, CommunityMcpSettings, CommunityMcpGroup } from '../../src/domain/admin-contract';
import type { CommunityExecutionInput, CommunityExecutionView } from '../../src/domain/admin-contract';
import type { CommunityPluginAccessInput, CommunityPluginAccessView } from '../../src/domain/admin-contract';
import type { CommunityPluginUpstreamAction, CommunityPluginUpstreamView, CommunityPluginUpstreamTestResult } from '../../src/domain/admin-contract';
import type {  CommunityPluginPublishAction, CommunityPluginPublishResult } from '../../src/domain/admin-contract';
import type { CommunityManagedGroupView, CommunityPluginGrantAction } from '../../src/domain/admin-contract';
import type { CommunityPluginAction, CommunityPluginView, CommunityPluginImpact, CommunityPluginChangeAction, CommunityPluginChangeResult } from '../../src/domain/admin-contract';
import type { CommunityGroupView, CommunityGroupAction } from '../../src/domain/admin-contract';
import type { CommunitySystemUpdateAction, CommunitySystemUpdateCheckResult, CommunitySystemUpdateStatus, CommunitySystemUpdateSubmission } from '../../src/domain/admin-contract';
import type { CommunityAccountActionRequest, CommunityAccountActionResult, CommunityAccountView, CommunityAccountsPageData, CommunityCreateAccountRequest, CommunityManagementSession, CommunityApiErrorBody, CommunityErrorParams } from '../../src/domain/admin-contract';
import type { CommunityEnvironmentResetResult, CommunityEnvironmentResetFailure } from '../../src/domain/admin-contract';
import type { CommunityModelAction, CommunityModelSettings } from '../../src/domain/admin-contract';

export class CommunityApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly params?: CommunityErrorParams) { super(message); }
}

async function request<T>(path: string, init?: RequestInit, recovery = false): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin' });
  if (response.status === 401) { (window.location.pathname === '/market' ? window.top ?? window : window).location.assign('/login'); throw new Error('Sign in is required'); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Request failed' })) as CommunityApiErrorBody | CommunityEnvironmentResetFailure;
    if (recovery && response.status === 503 && 'phase' in body) return body as T;
    throw new CommunityApiRequestError(body.error, response.status, body.code, body.params);
  }
  return await response.json() as T;
}
export function communitySession(signal?: AbortSignal): Promise<CommunityManagementSession> { return request('/admin/api/session', { signal }); }
export function communityAccounts(signal?: AbortSignal): Promise<CommunityAccountsPageData> { return request('/admin/api/accounts', { signal }); }
export function createCommunityAccount(input: CommunityCreateAccountRequest): Promise<CommunityAccountView> {
  return request('/admin/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}
export function actOnCommunityAccount(username: string, input: CommunityAccountActionRequest): Promise<CommunityAccountActionResult> {
  return request(`/admin/api/accounts/${encodeURIComponent(username)}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}
export function communityModels(signal?: AbortSignal): Promise<CommunityModelSettings> { return request('/admin/api/models', { signal }); }
export function updateCommunityModels(input: CommunityModelAction): Promise<CommunityModelSettings> {
  return request('/admin/api/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}

export function resetCommunityEnvironment(username: string): Promise<CommunityEnvironmentResetResult | CommunityEnvironmentResetFailure> {
  return request(`/admin/api/accounts/${encodeURIComponent(username)}/reset-environment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) }, true);
}

export function communitySystemUpdate(operation?: string, signal?: AbortSignal): Promise<CommunitySystemUpdateStatus> {
  return request(`/admin/api/system-update${operation ? `?operation=${encodeURIComponent(operation)}` : ''}`, { signal });
}
export function executeCommunitySystemUpdate(input: CommunitySystemUpdateAction): Promise<CommunitySystemUpdateCheckResult | CommunitySystemUpdateSubmission> {
  return request('/admin/api/system-update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}

export function communityGroups(signal?: AbortSignal): Promise<readonly CommunityGroupView[]> { return request('/admin/api/groups', { signal }); }
export function updateCommunityGroups(input: CommunityGroupAction): Promise<readonly CommunityGroupView[]> {
  return request('/admin/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}

export function communityPlugins(signal?: AbortSignal): Promise<readonly CommunityPluginView[]> { return request('/admin/api/plugins', { signal }); }
export function addCommunityPlugin(input: CommunityPluginAction): Promise<CommunityPluginView> {
  return request('/admin/api/plugins', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}

export function uploadCommunityPlugin(file: File, replacing?: string): Promise<CommunityPluginView> {
  return request('/admin/api/plugins/upload', { method: 'POST', headers: { 'content-type': 'application/gzip', 'x-plugin-filename': encodeURIComponent(file.name), ...(replacing ? { 'x-plugin-replace-package': replacing } : {}) }, body: file });
}

export function communityGroupPlugins(groupId: string, signal?: AbortSignal): Promise<CommunityManagedGroupView> { return request(`/admin/api/groups/${encodeURIComponent(groupId)}/plugins`, { signal }); }
export function updateCommunityGroupPlugins(groupId: string, action: CommunityPluginGrantAction): Promise<CommunityManagedGroupView> {
  return request(`/admin/api/groups/${encodeURIComponent(groupId)}/plugins`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) });
}

export function publishCommunityPlugin(input: CommunityPluginPublishAction): Promise<CommunityPluginPublishResult> {
  return request('/admin/api/plugins/publication', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}

export function communityPluginImpact(packageName: string): Promise<CommunityPluginImpact> { return request(`/admin/api/plugins/impact?packageName=${encodeURIComponent(packageName)}`); }
export function changeCommunityPlugin(input: CommunityPluginChangeAction): Promise<CommunityPluginChangeResult> {
  return request('/admin/api/plugins/change', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}

export function communityPluginUpstreams(packageName: string, signal?: AbortSignal): Promise<readonly CommunityPluginUpstreamView[]> {
  return request(`/admin/api/plugins/upstreams?packageName=${encodeURIComponent(packageName)}`, { signal });
}
export function updateCommunityPluginUpstreams(packageName: string, input: CommunityPluginUpstreamAction): Promise<readonly CommunityPluginUpstreamView[]> {
  return request(`/admin/api/plugins/upstreams?packageName=${encodeURIComponent(packageName)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}

export function testCommunityPluginUpstream(packageName: string, name: string): Promise<CommunityPluginUpstreamTestResult> {
  return request(`/admin/api/plugins/upstreams/test?packageName=${encodeURIComponent(packageName)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
}

export function communityPluginAccess(packageName: string, signal?: AbortSignal): Promise<CommunityPluginAccessView> {
  return request(`/admin/api/plugins/access?packageName=${encodeURIComponent(packageName)}`, { signal });
}
export function saveCommunityPluginAccess(packageName: string, input: CommunityPluginAccessInput): Promise<CommunityPluginAccessView> {
  return request(`/admin/api/plugins/access?packageName=${encodeURIComponent(packageName)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}

export function communitySkills(signal?: AbortSignal): Promise<readonly import('../../src/domain/admin-contract').CommunitySkillView[]> { return request('/admin/api/skills', { signal }); }
export function communitySkillDetail(name: string, signal?: AbortSignal): Promise<import('../../src/domain/admin-contract').CommunitySkillDetail> { return request(`/admin/api/skills/detail?name=${encodeURIComponent(name)}`, { signal }); }
export function uploadCommunitySkill(file: File): Promise<import('../../src/domain/admin-contract').CommunitySkillPreview> { return request('/admin/api/skills/upload', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file }); }
export function changeCommunitySkill(input: import('../../src/domain/admin-contract').CommunitySkillChangeAction): Promise<unknown> { return request('/admin/api/skills/change', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).finally(skillSynchronizationChanged); }

export function communityGroupSkills(groupId: string, signal?: AbortSignal): Promise<import('../../src/domain/admin-contract').CommunitySkillGroupView> { return request(`/admin/api/groups/${encodeURIComponent(groupId)}/skills`, { signal }); }
export function saveCommunityGroupSkills(groupId: string, names: readonly string[], revision: string, packs?: readonly string[]): Promise<import('../../src/domain/admin-contract').CommunitySkillGroupView> { return request<import('../../src/domain/admin-contract').CommunitySkillGroupView>(`/admin/api/groups/${encodeURIComponent(groupId)}/skills`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', names, revision, confirmed: true, ...(packs ? { packs } : {}) }) }).finally(skillSynchronizationChanged); }

export const skillSynchronizationEvent = 'community-skill-synchronization';
function skillSynchronizationChanged() { window.dispatchEvent(new Event(skillSynchronizationEvent)); }
export function communitySkillSynchronization(signal?: AbortSignal): Promise<import('../../src/domain/admin-contract').CommunitySkillSynchronization> { return request('/admin/api/skills/synchronization', { signal }); }
export function retrySkillSynchronization(): Promise<import('../../src/domain/admin-contract').CommunitySkillSynchronization> { return request<import('../../src/domain/admin-contract').CommunitySkillSynchronization>('/admin/api/skills/synchronization', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'retry' }) }).finally(skillSynchronizationChanged); }


export function communitySkillExecution(name: string, signal?: AbortSignal): Promise<CommunityExecutionView> { return request('/admin/api/skills/execution?name=' + encodeURIComponent(name), { signal }); }
export function saveCommunitySkillExecution(name: string, input: CommunityExecutionInput): Promise<CommunityExecutionView> { return request('/admin/api/skills/execution?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); }

export function reprepareCommunitySkillExecution(name: string): Promise<CommunityExecutionView> { return request('/admin/api/skills/execution/prepare?name=' + encodeURIComponent(name), { method: 'POST' }); }

export function executionSettings(signal?: AbortSignal): Promise<import('../../src/domain/admin-contract').CommunityExecutionSettings> { return request('/admin/api/execution/settings', { signal }); }
export function saveExecutionSettings(limits: import('../../src/domain/admin-contract').CommunityExecutionLimits): Promise<import('../../src/domain/admin-contract').CommunityExecutionSettings> { return request('/admin/api/execution/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(limits) }); }
export function executionRecords(username: string, owner: string, signal?: AbortSignal): Promise<readonly import('../../src/domain/admin-contract').CommunityExecutionRecord[]> { return request('/admin/api/execution/records?' + new URLSearchParams({ username, owner }), { signal }); }
export function tryExecution(owner: string, line: string, signal?: AbortSignal): Promise<import('../../src/domain/admin-contract').CommunityExecutionTrial> { return request('/admin/api/execution/trial', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner, line }), signal }); }

export function communitySkillPacks(signal?: AbortSignal): Promise<import('../../src/domain/admin-contract').CommunitySkillPackLibrary> { return request('/admin/api/skill-packs', { signal }); }
export function communitySkillPackDetail(name: string, signal?: AbortSignal): Promise<import('../../src/domain/admin-contract').CommunitySkillPackDetail> { return request('/admin/api/skill-packs/detail?name=' + encodeURIComponent(name), { signal }); }
export function saveCommunitySkillPack(pack: import('../../src/domain/admin-contract').CommunitySkillPackInput, revision: string, previousName?: string): Promise<import('../../src/domain/admin-contract').CommunitySkillPackView> { return request<import('../../src/domain/admin-contract').CommunitySkillPackView>('/admin/api/skill-packs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', pack, revision, ...(previousName ? { previousName } : {}) }) }).finally(skillSynchronizationChanged); }
export function removeCommunitySkillPack(name: string, deleteSkills: boolean, revision: string): Promise<unknown> { return request('/admin/api/skill-packs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'remove', name, deleteSkills, revision }) }).finally(skillSynchronizationChanged); }

export function previewSkillImport(file: File): Promise<import('../../src/domain/admin-contract').CommunitySkillImportPreview> { return request('/admin/api/skills/import?filename=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file }); }
export function confirmSkillImport(input: import('../../src/domain/admin-contract').CommunitySkillImportInput): Promise<unknown> { return request('/admin/api/skills/import/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).finally(skillSynchronizationChanged); }

export function previewGitSkills(source: string, updateName?: string): Promise<import('../../src/domain/admin-contract').CommunitySkillImportPreview> {
  return request('/admin/api/skills/import/git', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source, ...(updateName ? { updateName } : {}) }) });
}

export function communityMcp(signal?: AbortSignal): Promise<readonly CommunityMcpSettings[]> { return request('/admin/api/mcp', { signal }); }
export function updateCommunityMcp(input: CommunityMcpAction): Promise<readonly CommunityMcpSettings[]> {
  return request('/admin/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}
export function communityGroupMcp(id: string, signal?: AbortSignal): Promise<CommunityMcpGroup> { return request(`/admin/api/groups/${encodeURIComponent(id)}/mcp`, { signal }); }
export function saveCommunityGroupMcp(id: string, names: readonly string[]): Promise<CommunityMcpGroup> {
  return request(`/admin/api/groups/${encodeURIComponent(id)}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names }) });
}

export function testCommunityMcp(name: string): Promise<CommunityMcpSettings> { return request('/admin/api/mcp/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }); }

export function communityMcpCatalog(signal?: AbortSignal): Promise<readonly import('../../src/domain/admin-contract').CommunityMcpCatalogEntry[]> { return request('/admin/api/mcp/catalog', { signal }); }
export function importCommunityMcp(input: import('../../src/domain/admin-contract').CommunityMcpCatalogInput): Promise<readonly CommunityMcpSettings[]> {
  return request('/admin/api/mcp/catalog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'import', input }) });
}
export function retryCommunityMcp(name: string): Promise<readonly CommunityMcpSettings[]> {
  return request('/admin/api/mcp/catalog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'retry', name }) });
}

export function communityMcpUpdatePreview(name: string, signal?: AbortSignal): Promise<import('../../src/domain/admin-contract').CommunityMcpCatalogUpdatePreview> { return request('/admin/api/mcp/catalog/update?name=' + encodeURIComponent(name), { signal }); }
export function applyCommunityMcpUpdate(input: import('../../src/domain/admin-contract').CommunityMcpCatalogUpdateInput): Promise<readonly CommunityMcpSettings[]> { return request('/admin/api/mcp/catalog/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); }
