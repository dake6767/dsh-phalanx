import type { CommunityPluginAction, CommunityPluginChangeAction } from '../domain/admin-contract.js'
import { CommunityRequestError } from './community-request.js'

export function communityPluginInput(value: unknown): CommunityPluginAction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['action', 'packageName', 'version'].includes(key))
    || (input.action !== 'add' && input.action !== 'retry') || typeof input.packageName !== 'string' || typeof input.version !== 'string') throw invalid()
  return { action: input.action, packageName: input.packageName, version: input.version }
}
function invalid(): CommunityRequestError { return new CommunityRequestError(400, 'Invalid plugin action', 'plugin-action-invalid') }

export function communityPluginChangeInput(value: unknown): CommunityPluginChangeAction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const input = value as Record<string, unknown>
  if (typeof input.packageName !== 'string') throw invalid()
  if (input.action === 'prepare' && typeof input.version === 'string' && Object.keys(input).every(key => ['action', 'packageName', 'version'].includes(key)))
    return { action: 'prepare', packageName: input.packageName, version: input.version }
  if ((input.action === 'select' || input.action === 'remove') && input.confirmed === true && typeof input.revision === 'string'
    && Object.keys(input).every(key => ['action', 'packageName', 'revision', 'confirmed'].includes(key)))
    return { action: input.action, packageName: input.packageName, revision: input.revision, confirmed: true }
  throw invalid()
}
