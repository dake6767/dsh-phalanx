import { join } from 'node:path'
import { expect, it } from 'vitest'
import { postgresSkillService } from './fixtures/postgres-skill-service.js'
import { runtimeVersion } from './fixtures/runtime-version.js'
import { PostgresCommittedView } from '../src/adapters/postgres-committed-view.js'
import { PostgresRuntimeDependencyStore } from '../src/adapters/postgres-runtime-dependencies.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { FileRuntimeDependencyProjection } from '../src/adapters/runtime-dependency-projection.js'
import { createMcpStorage } from '../src/composition/mcp-storage.js'
import { PlatformDatabaseError } from '../src/domain/platform-database.js'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import { McpRuntimeDependencies } from '../src/use-cases/mcp-runtime-dependencies.js'
import { McpServices } from '../src/use-cases/mcp-services.js'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import { MemberRuntimeDependencies } from '../src/use-cases/member-runtime-dependencies.js'
import { SkillMembership } from '../src/use-cases/skill-membership.js'
import { SkillLibrary } from '../src/use-cases/skill-library.js'

it.each(['snapshot', 'distribution'] as const)('finishes committed MCP settings when publication interrupts the skill %s', async phase => {
  const f = await postgresSkillService(),
    rows = new PostgresRuntimeDependencyStore(f.database),
    tables = ['dsh_phalanx.runtime_dependencies']
  let release!: () => void,
    entered!: () => void,
    pause = false,
    trigger = false,
    publishing = false,
    interruptPublication = false,
    writer: Promise<void> | undefined,
    observed: unknown,
    observedAt: string | undefined,
    failure: unknown
  const began = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const committed = new PostgresCommittedView(f.database, tables, async () => {
    const snapshot = await rows.list()
    if (pause) {
      pause = false
      entered()
      await gate
    }
    return snapshot
  })
  const storage = createMcpStorage(f.database),
    dependencies = new RuntimeDependencies(
      f.accounts,
      {
        list: () => rows.list(),
        save: row => rows.save(row),
        remove: name => rows.remove(name),
        view: {
          list: () => committed.read(value => value),
          version: () => {
            committed.read(() => undefined)
            return f.database.writeRevision(tables)
          },
        },
      },
      {
        isolated: true,
        identity: input => input.prepareCommand,
        recover: async () => {},
        collect: async () => {},
        prepare: async () => {
          throw Error('The ready dependency must not be prepared again')
        },
      },
      { now: () => 1 },
    ),
    effective = new MemberEffectiveSkills(f.accounts, f.storage.library.view, f.storage.grants.view, f.storage.selections.view),
    memberDependencies: MemberRuntimeDependencies = new MemberRuntimeDependencies(
      f.accounts,
      effective,
      dependencies,
      undefined,
      () => true,
      username => mcp.memberDependencies(username),
    ),
    root = join(f.root, 'distribution'),
    projection = new FileRuntimeDependencyProjection(root, space => memberDependencies.versions(space)),
    distribution: FileSkillDistribution = new FileSkillDistribution(
      root,
      { directory: hash => join(f.root, 'artifacts', hash) },
      {
        prepare: (...args) => projection.prepare(...args),
        apply: () => projection.apply(),
        identity: async (...args) => {
          if (publishing && interruptPublication && args[0] === f.member.spaceId) {
            interruptPublication = false
            await interrupt()
          }
          try {
            return await projection.identity(...args)
          } catch (error) {
            observed = error
            observedAt = publishing ? 'distribution' : 'snapshot'
            release()
            await writer
            throw error
          }
        },
      },
    ),
    membership: SkillMembership = new SkillMembership(f.accounts, f.storage.library, f.storage.grants, f.storage.selections, effective, {
      synchronize: async members => {
        publishing = true
        try {
          await distribution.synchronize(members)
        } finally {
          publishing = false
        }
      },
      snapshot: async members => {
        try {
          return await distribution.snapshot(members)
        } catch (error) {
          observed = error
          observedAt = 'snapshot'
          release()
          await writer
          throw error
        }
      },
    }),
    library: SkillLibrary = new SkillLibrary(
      f.accounts,
      f.storage.library,
      {
        accept: async () => {
          throw Error('No upload in this scenario')
        },
        read: async () => ({ markdown: '', files: [] }),
        collect: async () => {},
        newToken: () => 'unused',
      },
      { now: () => 1 },
      membership,
    ),
    mcp: McpServices = new McpServices(
      f.accounts,
      storage,
      {
        synchronize: async () => {
          if (!trigger) return
          trigger = false
          if (phase === 'snapshot') await interrupt()
          else interruptPublication = true
        },
      },
      new McpRuntimeDependencies(storage, dependencies),
      [],
      () => library.recover(),
    )
  async function interrupt(): Promise<void> {
    pause = true
    writer = f.database.query('UPDATE dsh_phalanx.runtime_dependencies SET updated_at=updated_at+1 WHERE name=$1', ['browser-tools']).then(() => {})
    await began
  }
  try {
    await rows.save({
      name: 'browser-tools',
      prepareCommand: 'mkdir bin',
      pathDirectories: ['bin'],
      source: 'manual',
      stage: 'ready',
      updatedAt: 1,
      log: '',
      checks: [],
      current: runtimeVersion('a'),
    })
    await committed.initialize()
    await storage.initialize()
    const input = {
      name: 'p-browser',
      description: '',
      url: '',
      run: { location: 'member' as const, command: 'node', args: ['server.mjs'], env: [], runtimeDependencies: ['browser-tools'] },
    }
    await mcp.save(f.actor, input)
    await mcp.grant(f.actor, f.member.groupId, ['p-browser'])
    trigger = true
    await mcp.save(f.actor, { ...input, disabledTools: ['browser_navigate'] }).catch(error => {
      failure = error
    })
    expect(observed).toBeInstanceOf(PlatformDatabaseError)
    expect(observed).toMatchObject({ code: 'unavailable' })
    expect(observedAt).toBe(phase)
    expect((await storage.read()).services[0]?.disabledTools).toEqual(['browser_navigate'])
    expect(failure).toBeUndefined()
    expect(membership.synchronization()).toEqual({ pending: false })
  } finally {
    release()
    await Promise.allSettled(writer ? [writer] : [])
    await mcp.stop()
    await library.stop()
    await dependencies.stop()
    await storage.close()
    await committed.close()
    await f.close()
  }
})
