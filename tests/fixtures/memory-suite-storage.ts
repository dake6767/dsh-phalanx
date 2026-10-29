import { BusinessRuleError } from '../../src/domain/business-error.js'
import type { LibrarySkill } from '../../src/domain/skill-library.js'
import type { SkillPack } from '../../src/domain/skill-pack.js'
import type { LibraryPlugin } from '../../src/domain/plugin-library.js'
import type { RuntimeDependency } from '../../src/domain/runtime-dependency.js'
import type { ExecutionConfiguration } from '../../src/domain/platform-execution.js'
import type { CatalogInstallRow, CatalogRequestRow } from '../../src/ports/catalog-records.js'
import type { CommunityAccountStorePort } from '../../src/ports/community-accounts.js'
import type { SuiteRepositories, SuiteUnitOfWork } from '../../src/ports/suite-unit-of-work.js'
import { RuntimeDependencyConsumers } from '../../src/use-cases/runtime-dependency-consumers.js'

type Assignments = Map<string, readonly string[]>
export interface MemorySuiteFacts {
  readonly skills: Map<string, LibrarySkill>
  readonly packs: Map<string, SkillPack>
  readonly runtime: Map<string, RuntimeDependency>
  readonly execution: Map<string, ExecutionConfiguration>
  readonly plugins: Map<string, LibraryPlugin>
  readonly grants: Assignments
  readonly choices: Assignments
  readonly packGrants: Assignments
  readonly packChoices: Assignments
  readonly installs: Map<string, CatalogInstallRow>
  readonly requests: Map<string, CatalogRequestRow>
}
export const emptySuiteFacts = (): MemorySuiteFacts => ({
  skills: new Map(),
  packs: new Map(),
  runtime: new Map(),
  execution: new Map(),
  plugins: new Map(),
  grants: new Map(),
  choices: new Map(),
  packGrants: new Map(),
  packChoices: new Map(),
  installs: new Map(),
  requests: new Map(),
})
const changed = () => new BusinessRuleError('conflict', 'The fixture fact changed.', 'suite-task-running')
function assignments(map: Assignments) {
  return {
    get: async (id: string) => structuredClone(map.get(id) ?? []),
    set: async (id: string, names: readonly string[]) => {
      map.set(id, [...names])
    },
    retain: async (ids: readonly string[], names: readonly string[]) => {
      for (const id of ids)
        map.set(
          id,
          (map.get(id) ?? []).filter(name => names.includes(name)),
        )
    },
  }
}
function numbered<T extends { readonly name: string; readonly rowRevision?: number }>(map: Map<string, T>, removed: (name: string) => void = () => {}) {
  return {
    list: async () => structuredClone([...map.values()].map(row => ({ ...row, rowRevision: row.rowRevision ?? 1 }))),
    save: async (row: T, expected?: number | 'none') => {
      const current = map.get(row.name)
      if ((expected === 'none' && current) || (typeof expected === 'number' && (!current || (current.rowRevision ?? 1) !== expected))) throw changed()
      map.set(row.name, structuredClone({ ...row, rowRevision: current ? (current.rowRevision ?? 1) + 1 : 1 }))
    },
    remove: async (name: string, expected?: number) => {
      if (expected !== undefined && (map.get(name)?.rowRevision ?? 1) !== expected) throw changed()
      map.delete(name)
      removed(name)
    },
  }
}
/** Quick use-case fixture: transaction repositories read candidate facts, published together without an await. */
export function memorySuiteStorage(
  accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
  facts: MemorySuiteFacts,
  hooks: {
    readonly packSave?: () => void
    readonly executionRemove?: () => void
    readonly externalReferences?: (name: string) => readonly { kind: 'mcp' | 'execution'; name: string }[]
  } = {},
) {
  let token = 0,
    tail = Promise.resolve()
  const repositories = (state: MemorySuiteFacts): SuiteRepositories => {
    const clean = (maps: readonly Assignments[], name: string) => {
      for (const map of maps)
        for (const [id, names] of map)
          map.set(
            id,
            names.filter(item => item !== name),
          )
    }
    const library = numbered(state.skills, name => {
        clean([state.grants, state.choices], name)
        for (const [key, pack] of state.packs)
          if (pack.skills.includes(name)) state.packs.set(key, { ...pack, skills: pack.skills.filter(row => row !== name) })
      }),
      packStore = numbered(state.packs, name => clean([state.packGrants, state.packChoices], name))
    const execution: SuiteRepositories['execution'] = {
      get: async owner => structuredClone(state.execution.get(owner)),
      list: async () => [...state.execution].map(([owner, configuration]) => ({ owner, configuration: structuredClone(configuration) })),
      save: async (owner, configuration, expected) => {
        const current = state.execution.get(owner)
        if (expected !== undefined && expected !== (current?.rowRevision ?? 'none')) throw changed()
        state.execution.set(owner, structuredClone({ ...configuration, rowRevision: String(++token) }))
      },
      remove: async (owner, expected) => {
        hooks.executionRemove?.()
        if (expected !== undefined && state.execution.get(owner)?.rowRevision !== expected) throw changed()
        state.execution.delete(owner)
      },
    }
    const plugins: SuiteRepositories['plugins'] = {
      list: async () => structuredClone([...state.plugins.values()]),
      save: async (row, expected) => {
        const current = state.plugins.get(row.packageName)
        if ((expected === 'none' && current) || (typeof expected === 'number' && current?.revision !== expected)) throw changed()
        state.plugins.set(row.packageName, structuredClone({ ...row, revision: (current?.revision ?? 0) + 1 }))
      },
      remove: async name => {
        state.plugins.delete(name)
      },
    }
    const consumers = new RuntimeDependencyConsumers(library, execution, undefined, plugins)
    const unused = async (): Promise<never> => {
      throw Error('Plugin configuration requires the PostgreSQL fixture')
    }
    return {
      locks: { acquire: async () => {} },
      accounts: {
        ...accounts,
        lockDirectory: async () => {},
        lockMember: async () => {},
        lock: async (actor, _contributor, groups) => {
          const account = await accounts.get(actor.username)
          if (!account?.admin || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw changed()
          const known = await accounts.listGroups()
          if (groups.some(id => !known.some(row => row.id === id && row.kind === 'ordinary'))) throw changed()
        },
      },
      library,
      packs: {
        store: {
          ...packStore,
          save: async (...args) => {
            hooks.packSave?.()
            if (args[0].skills.some(name => !state.skills.has(name)))
              throw new BusinessRuleError('invalid', 'A selected pack skill is missing.', 'skill-pack-invalid')
            await packStore.save(...args)
          },
        },
        grants: assignments(state.packGrants),
        selections: assignments(state.packChoices),
      },
      grants: assignments(state.grants),
      selections: assignments(state.choices),
      execution,
      plugins,
      runtime: {
        list: async () => structuredClone([...state.runtime.values()]),
        save: async row => {
          state.runtime.set(row.name, structuredClone(row))
        },
        remove: async name => {
          state.runtime.delete(name)
        },
      },
      runtimeReferences: { list: async name => [...(await consumers.list(name)), ...(hooks.externalReferences?.(name) ?? [])] },
      expertReferences: { touch: async () => {}, detach: async () => {}, impact: async () => ({ experts: [], revision: 'none' }) },
      pluginAccess: { get: unused, list: unused, save: unused, remove: unused },
      pluginUpstreams: { list: unused, save: unused },
      pluginGrants: { get: async () => [], set: unused, remove: unused, retainGroups: unused, preinstalls: async () => [], configure: unused },
      pluginSelections: { get: unused, set: unused, members: unused, removePackage: unused, retainPackages: unused },
      installs: {
        list: async () => structuredClone([...state.installs.values()]),
        get: async id => structuredClone(state.installs.get(id)),
        lock: async (id, revision) => {
          const row = state.installs.get(id)
          if (!row || row.revision !== revision) throw changed()
          return structuredClone(row.record)
        },
        save: async (record, expected = 'none') => {
          if ((state.installs.get(record.id)?.revision ?? 'none') !== expected) throw changed()
          state.installs.set(record.id, { record: structuredClone(record), revision: String(++token) })
        },
        remove: async (id, revision) => {
          if (state.installs.get(id)?.revision !== revision) throw changed()
          state.installs.delete(id)
        },
      },
      requests: {
        lockLedger: async () => {},
        get: async id => structuredClone(state.requests.get(id)),
        save: async (requestId, result, expected = 'none') => {
          if ((state.requests.get(requestId)?.revision ?? 'none') !== expected) throw changed()
          state.requests.set(requestId, { requestId, result: structuredClone(result), revision: String(++token) })
          while (state.requests.size > 200) state.requests.delete(state.requests.keys().next().value!)
        },
      },
    }
  }
  const work: SuiteUnitOfWork = {
    run(operation, committed) {
      const result = tail.then(async () => {
        const candidate = structuredClone(facts),
          value = await operation(repositories(candidate))
        for (const key of Object.keys(facts) as (keyof MemorySuiteFacts)[]) {
          const destination = facts[key] as Map<string, unknown>
          destination.clear()
          for (const [id, row] of candidate[key]) destination.set(id, row)
        }
        committed?.(value)
        return value
      })
      tail = result.then(
        () => {},
        () => {},
      )
      return result
    },
  }
  return { ...repositories(facts), work, facts }
}
