import type { CommunityAccountRecord, CommunityAccountState } from '../../src/domain/community-account.js'
import type { CommunityAccountStatePort } from '../../src/ports/community-accounts.js'
import type { CommunityModelAuthority, CommunityModelRegistration } from '../../src/use-cases/community-model-authorization.js'

/** In-memory database port for policy tests; real transaction rollback is tested against SQLite. */
export function accountState(
  read: (username: string) => CommunityAccountState | undefined | Promise<CommunityAccountState | undefined>,
): CommunityAccountStatePort {
  return {
    getState: async username => await read(username),
    withCurrentState: async (username, register) => {
      const state = await read(username),
        undo: (() => void)[] = []
      const record = state ? ({ admin: false, email: '', groupId: 'members', createdAt: 0, updatedAt: 0, ...state } as CommunityAccountRecord) : undefined
      try {
        return register(record, cleanup => {
          undo.push(cleanup)
        })
      } catch (error) {
        for (const cleanup of undo.reverse()) cleanup()
        throw error
      }
    },
  }
}
/** Fake authorization port for transport tests that do not exercise account storage. */
export function modelAuthority(authorize: CommunityModelAuthority['authorize']): CommunityModelAuthority {
  return {
    authorize,
    register: async <T>(
      header: string | string[] | undefined,
      register: CommunityModelRegistration<T>,
      identified?: Parameters<CommunityModelAuthority['authorize']>[1],
    ) => {
      const username = await authorize(header, identified),
        undo: (() => void)[] = []
      try {
        return register(username, cleanup => {
          undo.push(cleanup)
        })
      } catch (error) {
        for (const cleanup of undo.reverse()) cleanup()
        throw error
      }
    },
  }
}

export function pluginAuthority(
  authorize: import('../../src/use-cases/plugin-upstream-access.js').PluginUpstreamAccess['authorize'],
): Pick<import('../../src/use-cases/plugin-upstream-access.js').PluginUpstreamAccess, 'authorize' | 'register'> {
  return {
    authorize,
    register: async (packageName, name, headers, register) => {
      const admission = await authorize(packageName, name, headers),
        undo: (() => void)[] = []
      try {
        return register(admission, cleanup => {
          undo.push(cleanup)
        })
      } catch (error) {
        for (const cleanup of undo.reverse()) cleanup()
        throw error
      }
    },
  }
}

/** Transport-only fixtures use fixed policy unless the test supplies a changing local snapshot. */
export function mcpPolicy<
  T extends Pick<import('../../src/use-cases/mcp-services.js').McpServices, 'effective'> &
    Partial<Pick<import('../../src/use-cases/mcp-services.js').McpServices, 'diagnostic' | 'accessible' | 'version'>>,
>(
  services: T,
  snapshot: () => unknown = () => services.version?.(),
): NoInfer<T> & Pick<import('../../src/use-cases/mcp-services.js').McpServices, 'captureLocalPolicy'> {
  return {
    ...services,
    captureLocalPolicy: () => {
      const initial = JSON.stringify(snapshot())
      return () => {
        if (JSON.stringify(snapshot()) !== initial) throw Error('MCP fixture policy changed')
      }
    },
  }
}
