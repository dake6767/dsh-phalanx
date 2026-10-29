import { CommunityModelAccessError } from '../domain/community-model.js'
import type { UsageMember } from '../domain/usage-record.js'
import type { CommunityAccountRegistration, CommunityAccountStatePort } from '../ports/community-accounts.js'
import type { CommunityModelAccessPort } from '../ports/community-model-access.js'

export type CommunityModelRegistration<T> = (username: string, onAbort: (cleanup: () => void) => void) => ReturnType<CommunityAccountRegistration<T>>
export type CommunityModelAuthority = Pick<CommunityModelAuthorization, 'authorize' | 'register'>

/** Account mutations and connection registration are ordered by the database, never a cached revision. */
export class CommunityModelAuthorization {
  constructor(
    private readonly accounts: Pick<CommunityAccountStatePort, 'withCurrentState'>,
    private readonly access: Pick<CommunityModelAccessPort, 'resolve'>,
  ) {}
  async authorize(header: string | string[] | undefined, identified?: (member: UsageMember) => void): Promise<string> {
    return await this.register(header, username => username, identified)
  }
  async register<T>(header: string | string[] | undefined, register: CommunityModelRegistration<T>, identified?: (member: UsageMember) => void): Promise<T> {
    const initial = this.identity(header)
    return await this.accounts.withCurrentState(initial.username, (account, onAbort) => {
      const current = this.identity(header)
      if (current.username !== initial.username || current.spaceId !== initial.spaceId) throw new CommunityModelAccessError('unauthenticated')
      if (account === undefined || account.spaceId !== current.spaceId) throw new CommunityModelAccessError('forbidden')
      identified?.({ username: account.username, groupId: account.groupId })
      if (account.disabled) throw new CommunityModelAccessError('forbidden')
      return register(account.username, onAbort)
    })
  }
  private identity(header: string | string[] | undefined) {
    const identity = typeof header === 'string' ? this.access.resolve(header) : undefined
    if (identity === undefined) throw new CommunityModelAccessError('unauthenticated')
    return identity
  }
}

/** Every async admission boundary obtains current database facts again. */
export async function admitCommunityModel(
  authority: CommunityModelAuthority,
  header: string | string[] | undefined,
  identified?: (member: UsageMember) => void,
) {
  let member: UsageMember | undefined
  const username = await authority.authorize(header, current => {
    member = current
    identified?.(current)
  })
  const sameMember = (current: string) => {
    if (current !== username) throw new CommunityModelAccessError('forbidden')
    return current
  }
  return {
    username,
    current: async (): Promise<string> => sameMember(await authority.authorize(header)),
    register: async <T>(register: CommunityModelRegistration<T>): Promise<T> =>
      await authority.register(
        header,
        (current, onAbort) => register(sameMember(current), onAbort),
        current => {
          if (member && current.groupId !== member.groupId) throw new CommunityModelAccessError('forbidden')
        },
      ),
  }
}
