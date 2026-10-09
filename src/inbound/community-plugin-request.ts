import type { CommunityPluginAction } from '../domain/admin-contract.js'
import { CommunityRequestError } from './community-request.js'

export function communityPluginInput(value: unknown): CommunityPluginAction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['action', 'packageName', 'version'].includes(key))
    || (input.action !== 'add' && input.action !== 'retry') || typeof input.packageName !== 'string' || typeof input.version !== 'string') throw invalid()
  return { action: input.action, packageName: input.packageName, version: input.version }
}
function invalid(): CommunityRequestError { return new CommunityRequestError(400, 'Invalid plugin action', 'plugin-action-invalid') }
