import { asyncSkillFacts } from './fixtures/async-skill-facts.js'
import { expect, it } from 'vitest'
import { ContributionPolicy } from '../src/use-cases/contribution-policy.js'
import {
  administratorLibraryVersion,
  contributionFileChanges,
  comparePluginVersions,
  libraryContributionCredit,
  libraryContributionProvenance,
} from '../src/domain/library-contribution.js'
import { PluginLibrary } from '../src/use-cases/plugin-library.js'
import type { LibraryPlugin, PreparedPlugin } from '../src/domain/plugin-library.js'
import type { MemberContribution } from '../src/domain/member-contribution.js'
const actor = {
  username: 'admin',
  spaceId: 'admin-space',
  sessionEpoch: 0,
  admin: true,
  disabled: false,
  groupId: 'admins',
  email: '',
  createdAt: 0,
  updatedAt: 0,
}
const member = { ...actor, username: 'member', spaceId: 'member-space', admin: false }
const prepared: PreparedPlugin = {
  packageName: 'shared',
  version: '1.0.0',
  integrity: 'pinned',
  artifact: 'private',
  runtimeRevision: 'runtime',
  title: '',
  description: '',
  dependencies: {},
  bundlePatch: '[]',
}
const contribution: MemberContribution = {
  kind: 'plugin',
  id: 'id',
  revision: 'revision',
  name: 'shared',
  description: '',
  hash: 'fingerprint',
  markdown: '',
  files: ['package.json'],
  fileHashes: { 'package.json': 'manifest' },
  contributor: member,
  declaration: { purpose: 'Share fixture' },
  submittedAt: 1,
  updatedAt: 1,
  status: 'pending',
  plugin: { candidate: prepared, prepared },
}
it('assigns new contributions, leaves legacy entries unowned by default, and preserves maintainer and anonymous credit through administrator replacements', () => {
  expect(libraryContributionProvenance(undefined, { row: contribution }, false).maintainer).toEqual({ username: member.username, spaceId: member.spaceId })
  expect(libraryContributionProvenance(undefined, { row: contribution }, true).maintainer).toBeNull()
  const owned = libraryContributionProvenance(undefined, { row: contribution, maintenance: { assignMaintainer: true, anonymous: true } }, true)
  expect(libraryContributionCredit(owned)).toEqual({ anonymous: true })
  const replaced = administratorLibraryVersion(owned, '1.0.1', 'next', actor, 2)
  expect(replaced.maintainer).toEqual(owned.maintainer)
  expect(replaced.versions.at(-1)?.source).toBe('administrator')
  expect(libraryContributionCredit(replaced)).toEqual({ anonymous: true })
})
it('blocks nonmaintainers including reused usernames and requires strictly increasing SemVer while allowing replacement of a pending update', async () => {
  const row: LibraryPlugin = {
    ...prepared,
    current: prepared,
    stage: 'available',
    published: false,
    provenance: libraryContributionProvenance(undefined, { row: contribution }, false),
  }
  const policy = new ContributionPolicy(asyncSkillFacts({ list: () => [] }), { list: async () => [row] }, { read: async () => ({ markdown: '', files: [] }) })
  await expect(policy.check('plugin', actor, 'shared', '1.0.1')).rejects.toThrow(
    expect.objectContaining({ code: 'contribution-maintainer-required', params: { maintainer: 'member' } }),
  )
  await expect(policy.check('plugin', { ...member, spaceId: 'reused-space' }, 'shared', '1.0.1')).rejects.toThrow(
    expect.objectContaining({ code: 'contribution-maintainer-required' }),
  )
  for (const version of ['0.9.9', '1.0.0', '1.0.0+different', '1.0.0-rc.1'])
    await expect(policy.check('plugin', member, 'shared', version)).rejects.toThrow(expect.objectContaining({ code: 'contribution-version-required' }))
  await policy.check('plugin', member, 'shared', '1.0.1')
  await policy.check('plugin', member, 'shared', '1.0.1')
  expect(comparePluginVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1)
  expect(comparePluginVersions('1.0.0-a-b', '1.0.0-a-c')).toBe(-1)
  expect(comparePluginVersions('999999999999999999999.0.0', '999999999999999999998.0.0')).toBe(1)
})
it('shows added, modified and deleted skill files and declaration changes against the actual previous artifact', async () => {
  const policy = new ContributionPolicy(
    asyncSkillFacts({ list: () => [{ name: 'shared', description: 'Skill', hash: 'old', importedAt: 0, published: false }] }),
    { list: async () => [] },
    { read: async () => ({ markdown: '', files: ['SKILL.md', 'old.py'], fileHashes: { 'SKILL.md': 'old', 'old.py': 'removed' } }) },
  )
  const { plugin, ...skill } = contribution
  void plugin
  const result = await policy.review({ ...skill, kind: 'skill', fileHashes: { 'SKILL.md': 'new', 'new.py': 'added' } })
  expect(result).toMatchObject({
    maintainer: null,
    canAssignMaintainer: true,
    changes: { added: ['new.py'], changed: ['SKILL.md'], deleted: ['old.py'], declaration: { after: contribution.declaration } },
  })
})
it('commits provenance with the selected contribution version and keeps it when an administrator changes the version', async () => {
  let rows: LibraryPlugin[] = []
  const library = new PluginLibrary(
    { get: async name => (name === actor.username ? actor : member) },
    {
      list: async () => rows,
      save: async row => {
        rows = [...rows.filter(old => old.packageName !== row.packageName), row]
      },
      remove: async () => {},
    },
    { prepare: async input => ({ ...prepared, version: input.version, integrity: 'next' }) },
    undefined,
    { impact: async () => ({ groups: 0, members: 0 }), revoke: async () => {} },
  )
  await library.adoptContribution(
    actor,
    prepared,
    prepared,
    'new',
    { id: contribution.id, revision: contribution.revision, adoption: { row: contribution } },
    () => {},
  )
  expect(rows[0]?.provenance?.maintainer).toEqual({ username: member.username, spaceId: member.spaceId })
  await library.replace(actor, { packageName: prepared.packageName, version: '1.0.1' })
  await library.drain()
  await library.select(actor, prepared.packageName, (await library.impact(actor, prepared.packageName)).revision)
  expect(rows[0]?.provenance?.maintainer?.username).toBe('member')
  expect(rows[0]?.provenance?.versions.map(row => row.source)).toEqual(['member', 'administrator'])
})

it('retains public environment references in adopted version declarations so identical updates have no declaration diff', () => {
  const declaration = {
    purpose: 'Search',
    plugin: {
      upstreams: [],
      environment: [{ name: 'ANYSEARCH_API_KEY', secret: true, purpose: 'Authenticate', application: 'Dashboard' }],
      entriesYaml: JSON.stringify({ search: { apiKeyEnv: 'ANYSEARCH_API_KEY' } }),
    },
  }
  const adopted = libraryContributionProvenance(undefined, { row: { ...contribution, declaration } }, false)
  expect(adopted.versions.at(-1)?.declaration).toEqual(declaration)
  const changes = contributionFileChanges(contribution.fileHashes!, contribution.fileHashes!, adopted.versions.at(-1)?.declaration, declaration)
  expect(changes).toEqual({ added: [], changed: [], deleted: [] })
})
