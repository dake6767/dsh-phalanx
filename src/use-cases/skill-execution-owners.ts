import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ExecutionConfigurationPort } from '../ports/platform-execution.js'
import type { ExecutionOwnerInventoryPort } from '../ports/platform-execution.js'
import type { SkillLibraryView } from '../ports/skill-library.js'
import type { MemberEffectiveSkills } from './member-effective-skills.js'

/** Skills are the first execution owner; credentials and execution policy remain owner-independent. */
export class SkillExecutionOwners implements ExecutionOwnerInventoryPort {
  constructor(
    private readonly library: Pick<SkillLibraryView, 'list'>,
    private readonly effective: MemberEffectiveSkills,
    private readonly accounts: Pick<CommunityAccountStorePort, 'list'>,
    private readonly configuration: ExecutionConfigurationPort,
  ) {}
  identities(): readonly string[] {
    return this.library.list().map(skill => `skill:${skill.name}`)
  }
  get(id: string) {
    const skill = this.library.list().find(row => `skill:${row.name}` === id && !row.conflict)
    return skill
      ? {
          id,
          version: skill.hash,
          ...(skill.contributionReceipt ? { preparationApproval: JSON.stringify([skill.contributionReceipt.id, skill.contributionReceipt.revision]) } : {}),
        }
      : undefined
  }
  async commands(spaceId: string) {
    const account = (await this.accounts.list()).find(row => row.spaceId === spaceId && !row.disabled)
    if (!account) return []
    return (
      await Promise.all(
        (await this.effective.accessible(account.username)).map(async skill => {
          const owner = `skill:${skill.name}`,
            config = await this.configuration.get(owner)
          return config
            ? config.commands
                .filter(row => config.enabled || (config.suiteOrigin && (row.memberPath || row.command.includes('/'))))
                .map(row => ({
                  owner,
                  skill: skill.name,
                  command: row.command,
                  ...(row.source ? { source: row.source } : {}),
                  ...(row.memberPath ? { memberPath: row.memberPath } : {}),
                }))
            : []
        }),
      )
    ).flat()
  }
  async owns(username: string, id: string): Promise<boolean> {
    return (await this.effective.accessible(username)).some(skill => `skill:${skill.name}` === id)
  }
}
