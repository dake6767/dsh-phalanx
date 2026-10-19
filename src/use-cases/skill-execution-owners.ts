import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ExecutionConfigurationPort } from '../ports/platform-execution.js'
import type { ExecutionOwnerInventoryPort } from '../ports/platform-execution.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { MemberEffectiveSkills } from './member-effective-skills.js'

/** Skills are the first execution owner; credentials and execution policy remain owner-independent. */
export class SkillExecutionOwners implements ExecutionOwnerInventoryPort {
  constructor(private readonly library: Pick<SkillLibraryStorePort, 'list'>, private readonly effective: MemberEffectiveSkills,
    private readonly accounts: Pick<CommunityAccountStorePort, 'list'>, private readonly configuration: ExecutionConfigurationPort) {}
  identities(): readonly string[] { return this.library.list().map(skill => `skill:${skill.name}`) }
  get(id: string) {
    const skill = this.library.list().find(row => `skill:${row.name}` === id && !row.conflict)
    return skill ? { id, version: skill.hash, ...(skill.contributionReceipt ? { preparationApproval: JSON.stringify([skill.contributionReceipt.id, skill.contributionReceipt.revision]) } : {}) } : undefined
  }
  commands(spaceId: string) {
    const account = this.accounts.list().find(row => row.spaceId === spaceId && !row.disabled)
    if (!account) return []
    return this.effective.accessible(account.username).flatMap(skill => {
      const owner = `skill:${skill.name}`, config = this.configuration.get(owner)
      return config?.enabled ? config.commands.map(row => ({ owner, skill: skill.name, command: row.command })) : []
    })
  }
  owns(username: string, id: string): boolean { return this.effective.accessible(username).some(skill => `skill:${skill.name}` === id) }
}
