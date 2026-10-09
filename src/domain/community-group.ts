import { BusinessRuleError } from './business-error.js'
/** Single-group account membership; only ordinary groups may be the default. */
export interface CommunityGroupRecord {
  readonly id: string
  readonly name: string
  readonly kind: 'ordinary' | 'admin'
  readonly isDefault: boolean
  readonly memberCount: number
}

export function requiredCommunityGroup(groups: readonly CommunityGroupRecord[], id: string): CommunityGroupRecord {
  const group = groups.find(value => value.id === id)
  if (group === undefined) throw new BusinessRuleError('missing', 'Group was not found', 'group-not-found')
  return group
}
export function assertGroupDeletion(group: CommunityGroupRecord): void {
  if (group.kind === 'admin' || group.isDefault) throw new BusinessRuleError('conflict', 'This group is protected', 'group-protected')
  if (group.memberCount !== 0) throw new BusinessRuleError('conflict', 'Move every member before deleting the group', 'group-has-members')
}
export function assertOrdinaryGroup(group: CommunityGroupRecord): void {
  if (group.kind === 'admin') throw new BusinessRuleError('conflict', 'This group is protected', 'group-protected')
}
export function validatedGroupName(groups: readonly CommunityGroupRecord[], name: string, except?: string): string {
  const value = name.trim()
  if (value.length === 0 || value.length > 80) throw new BusinessRuleError('invalid', 'Group name must contain 1 to 80 characters', 'group-name-invalid')
  if (groups.some(group => group.id !== except && group.name === value)) throw new BusinessRuleError('conflict', 'Group name is already in use', 'group-name-in-use')
  return value
}

export function assertCommunityGroupRole(group: CommunityGroupRecord, admin: boolean): void {
  if ((group.kind === 'admin') !== admin) throw new BusinessRuleError('conflict', 'The group must match the account role', 'group-role-conflict')
}
