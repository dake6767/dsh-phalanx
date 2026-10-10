import type { CommunityPluginAccessInput, CommunityPluginAccessView } from '../../src/domain/admin-contract';
import type { CommunityMarketPageData } from '../../src/domain/admin-contract';
import type { CommunityPluginUpstreamAction, CommunityPluginUpstreamView, CommunityPluginUpstreamTestResult } from '../../src/domain/admin-contract';
import type {  CommunityMarketInstallResult, CommunityMarketInstallAction, CommunityPluginPublishAction, CommunityPluginPublishResult } from '../../src/domain/admin-contract';
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

export function communityMarket(signal?: AbortSignal): Promise<CommunityMarketPageData> { return request('/market/api/plugins', { signal }); }
export function installMarketPlugin(input: CommunityMarketInstallAction): Promise<CommunityMarketInstallResult> {
  return request('/market/api/plugins', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
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
export function saveCommunityGroupSkills(groupId: string, names: readonly string[], revision: string): Promise<import('../../src/domain/admin-contract').CommunitySkillGroupView> { return request<import('../../src/domain/admin-contract').CommunitySkillGroupView>(`/admin/api/groups/${encodeURIComponent(groupId)}/skills`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', names, revision, confirmed: true }) }).finally(skillSynchronizationChanged); }

export const skillSynchronizationEvent = 'community-skill-synchronization';
function skillSynchronizationChanged() { window.dispatchEvent(new Event(skillSynchronizationEvent)); }
export function communitySkillSynchronization(signal?: AbortSignal): Promise<import('../../src/domain/admin-contract').CommunitySkillSynchronization> { return request('/admin/api/skills/synchronization', { signal }); }
export function retrySkillSynchronization(): Promise<import('../../src/domain/admin-contract').CommunitySkillSynchronization> { return request<import('../../src/domain/admin-contract').CommunitySkillSynchronization>('/admin/api/skills/synchronization', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'retry' }) }).finally(skillSynchronizationChanged); }
