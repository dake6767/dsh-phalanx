import { asyncSkillFacts } from './fixtures/async-skill-facts.js'
import { expect, it } from 'vitest'
import { SkillLibrary } from './fixtures/skill-library.js'
import { SkillMembership } from '../src/use-cases/skill-membership.js'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import { MemberContributions } from '../src/use-cases/member-contributions.js'
import { memoryContributions } from './fixtures/contributions.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'
import type { CommunityRuntimeDependencyView } from '../src/domain/admin-contract.js'

it('matches required commands for administrator adoption, prepares missing choices and retains references on updates', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 },
    account = { ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }
  const accounts = { get: async () => account, list: async () => [account], listGroups: async () => [] }
  let rows: LibrarySkill[] = [],
    serial = 0,
    version = 1
  const store = {
    list: () => rows,
    save: (row: LibrarySkill) => {
      rows = [...rows.filter(old => old.name !== row.name), row]
    },
    remove() {},
  }
  const assignments = { get: () => [], set() {}, retain() {} }
  const membership = new SkillMembership(
    accounts,
    asyncSkillFacts(store),
    asyncSkillFacts(assignments),
    asyncSkillFacts(assignments),
    new MemberEffectiveSkills(accounts, store, assignments, assignments),
    {
      synchronize: async () => {},
    },
  )
  const installed = new Map<string, CommunityRuntimeDependencyView>()
  const install = (name: string, command: string) =>
    installed.set(name, {
      name,
      source: 'manual',
      stage: 'ready',
      isolated: true,
      updatedAt: 0,
      log: '',
      checks: [],
      references: [],
      prepareCommand: 'install',
      pathDirectories: ['bin'],
      current: { id: name + '-version', commands: [command], bytes: 1, isolated: true },
    })
  install('lark-runtime', 'lark-cli')
  const dependencies = {
    list: async () => [...installed.values()],
    readReady: async (names: readonly string[]) => {
      if (names.some(name => !installed.has(name))) throw Error('dependency unavailable')
      return []
    },
  }
  const upload = () => ({ name: 'guide', description: 'Guide', hash: `artifact-${version}`, markdown: '# Guide', files: ['SKILL.md'] })
  const library = new SkillLibrary(
    accounts,
    asyncSkillFacts(store),
    { accept: async () => upload(), read: async () => upload(), collect: async () => {}, newToken: () => String(++serial) },
    { now: () => 0 },
    membership,
    undefined,
    [],
    undefined,
    undefined,
    dependencies,
  )
  const contributions = new MemberContributions(
    accounts,
    memoryContributions(undefined, {
      skill: async row => {
        store.save(row)
      },
    }),
    { accept: async () => upload(), read: async () => new Uint8Array(), collect: async () => {}, newId: () => String(++serial) },
    library,
    { now: () => 0 },
  )
  const declaration = (names: string[]) => ({
    purpose: 'Team documents',
    requiredCommands: names.map(name => ({ name, purpose: 'Read documents', installation: 'Install a pinned binary into bin' })),
  })
  async function* bytes() {
    yield new Uint8Array([1])
  }
  const row = await contributions.submit(actor, declaration(['lark-cli', 'officecli']), bytes(), new AbortController().signal)
  const review = await contributions.review(actor, row.id, row.revision)
  expect(review.dependencies).toMatchObject({
    references: ['lark-runtime'],
    requirements: [
      { name: 'lark-cli', dependency: 'lark-runtime', added: true },
      { name: 'officecli', added: true },
    ],
    removed: [],
  })
  expect(JSON.stringify(await contributions.list(actor))).not.toContain('lark-runtime')
  await expect(contributions.decide(actor, row.id, { action: 'adopt', revision: row.revision, token: review.token })).rejects.toThrow()
  expect(await library.list(actor)).toEqual([])
  install('office-runtime', 'officecli')
  await contributions.decide(actor, row.id, {
    action: 'adopt',
    revision: row.revision,
    token: review.token,
    setup: { runtimeDependencies: ['lark-runtime', 'office-runtime'] },
  })
  expect((await library.list(actor))[0]?.runtimeDependencies).toEqual(['lark-runtime', 'office-runtime'])
  version = 2
  install('minimax-runtime', 'mmx')
  const update = await contributions.submit(actor, declaration(['mmx']), bytes(), new AbortController().signal)
  const changed = await contributions.review(actor, update.id, update.revision)
  expect(changed.dependencies).toMatchObject({ references: ['lark-runtime', 'office-runtime', 'minimax-runtime'], removed: ['lark-cli', 'officecli'] })
  await contributions.decide(actor, update.id, { action: 'adopt', revision: update.revision, token: changed.token })
  expect((await library.list(actor))[0]?.runtimeDependencies).toEqual(['lark-runtime', 'office-runtime', 'minimax-runtime'])
  await contributions.recover()
  expect(await library.list(actor)).toHaveLength(1)
})
