import type { CommunityPluginPreview, CommunityPluginView } from '../../src/domain/admin-contract'
import { request } from './community-api'

export function precheckCommunityPlugin(input: string, signal?: AbortSignal): Promise<CommunityPluginPreview> {
  return request('/admin/api/plugins/previews', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }), signal })
}
export function communityPluginPreview(token: string, signal?: AbortSignal): Promise<CommunityPluginPreview> {
  return request('/admin/api/plugins/previews?token=' + encodeURIComponent(token), { signal })
}
export function retryCommunityPluginPreview(token: string, signal?: AbortSignal): Promise<CommunityPluginPreview> {
  return request('/admin/api/plugins/previews/retry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
    signal,
  })
}
export function confirmCommunityPluginPreview(token: string, signal?: AbortSignal): Promise<CommunityPluginView> {
  return request('/admin/api/plugins/previews/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
    signal,
  })
}
export function cancelCommunityPluginPreview(token: string, signal?: AbortSignal): Promise<void> {
  return request('/admin/api/plugins/previews/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
    signal,
  })
}
