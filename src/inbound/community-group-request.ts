import type { CommunityGroupAction } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
export function communityGroupInput(value: unknown): CommunityGroupAction {
  const fail = () => new BusinessRuleError('invalid', 'Invalid group action', 'group-action-invalid')
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail()
  const body = value as Record<string, unknown>
  const fields: Record<string, readonly string[]> = { create: ['action', 'name'], rename: ['action', 'id', 'name'], delete: ['action', 'id'], 'set-default': ['action', 'id', 'confirmed'] }
  if (typeof body.action !== 'string' || !Object.hasOwn(fields, body.action)) throw fail()
  const allowed = fields[body.action]!
  if (Object.keys(body).length !== allowed.length || Object.keys(body).some(key => !allowed.includes(key))) throw fail()
  if (body.action !== 'create' && typeof body.id !== 'string') throw fail()
  if (['create', 'rename'].includes(body.action) && typeof body.name !== 'string') throw fail()
  if (body.action === 'set-default' && body.confirmed !== true) throw fail()
  return body as unknown as CommunityGroupAction
}
