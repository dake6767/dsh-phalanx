import type { CommunityAccountActionRequest, CommunityAccountActionResult, CommunityAccountView, CommunityAccountsPageData, CommunityCreateAccountRequest, CommunitySessionInfo, CommunityApiErrorBody } from '../../src/domain/admin-contract';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin' });
  if (response.status === 401) { window.location.assign('/login'); throw new Error('Sign in is required'); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Request failed' })) as CommunityApiErrorBody;
    throw new Error(body.error);
  }
  return await response.json() as T;
}
export function communitySession(signal?: AbortSignal): Promise<CommunitySessionInfo> { return request('/admin/api/session', { signal }); }
export function communityAccounts(signal?: AbortSignal): Promise<CommunityAccountsPageData> { return request('/admin/api/accounts', { signal }); }
export function createCommunityAccount(input: CommunityCreateAccountRequest): Promise<CommunityAccountView> {
  return request('/admin/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}
export function actOnCommunityAccount(username: string, input: CommunityAccountActionRequest): Promise<CommunityAccountActionResult> {
  return request(`/admin/api/accounts/${encodeURIComponent(username)}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}
