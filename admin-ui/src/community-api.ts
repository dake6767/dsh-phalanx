import type { CommunityPluginAction, CommunityPluginView } from '../../src/domain/admin-contract';
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
  if (response.status === 401) { window.location.assign('/login'); throw new Error('Sign in is required'); }
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
