import { expect, it } from 'vitest'
import { ContributionPolicy } from '../src/use-cases/contribution-policy.js'
import { administratorLibraryVersion, comparePluginVersions, libraryContributionCredit, libraryContributionProvenance } from '../src/domain/library-contribution.js'
import { PluginLibrary } from '../src/use-cases/plugin-library.js'
import type { LibraryPlugin, PreparedPlugin } from '../src/domain/plugin-library.js'
import type { MemberContribution } from '../src/domain/member-contribution.js'
const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }
const member = { ...actor, username: 'member', spaceId: 'member-space', admin: false }
const prepared: PreparedPlugin = { packageName: 'shared', version: '1.0.0', integrity: 'pinned', artifact: 'private', runtimeRevision: 'runtime', title: '', description: '', dependencies: {}, bundlePatch: '[]' }
const contribution: MemberContribution = { kind: 'plugin', id: 'id', revision: 'revision', name: 'shared', description: '', hash: 'fingerprint', markdown: '', files: ['package.json'], fileHashes: { 'package.json': 'manifest' }, contributor: member, declaration: { purpose: 'Share fixture' }, submittedAt: 1, updatedAt: 1, status: 'pending', plugin: { candidate: prepared, prepared } }
it('assigns new contributions, leaves legacy entries unowned by default, and preserves maintainer and anonymous credit through administrator replacements', () => {
  expect(libraryContributionProvenance(undefined, { row: contribution }, false).maintainer).toEqual({ username: member.username, spaceId: member.spaceId })
  expect(libraryContributionProvenance(undefined, { row: contribution }, true).maintainer).toBeNull()
  const owned = libraryContributionProvenance(undefined, { row: contribution, maintenance: { assignMaintainer: true, anonymous: true } }, true)
  expect(libraryContributionCredit(owned)).toEqual({ anonymous: true })
  const replaced = administratorLibraryVersion(owned, '1.0.1', 'next', actor, 2)
  expect(replaced.maintainer).toEqual(owned.maintainer); expect(replaced.versions.at(-1)?.source).toBe('administrator')
  expect(libraryContributionCredit(replaced)).toEqual({ anonymous: true })
})
it('blocks nonmaintainers including reused usernames and requires strictly increasing SemVer while allowing replacement of a pending update', () => {
  const row: LibraryPlugin = { ...prepared, current: prepared, stage: 'available', published: false, provenance: libraryContributionProvenance(undefined, { row: contribution }, false) }
  const policy = new ContributionPolicy({ list: () => [] }, { list: () => [row] }, { read: async () => ({ markdown: '', files: [] }) })
  expect(() => policy.check('plugin', actor, 'shared', '1.0.1')).toThrow(expect.objectContaining({ code: 'contribution-maintainer-required', params: { maintainer: 'member' } }))
  expect(() => policy.check('plugin', { ...member, spaceId: 'reused-space' }, 'shared', '1.0.1')).toThrow(expect.objectContaining({ code: 'contribution-maintainer-required' }))
  for (const version of ['0.9.9', '1.0.0', '1.0.0+different', '1.0.0-rc.1']) expect(() => policy.check('plugin', member, 'shared', version)).toThrow(expect.objectContaining({ code: 'contribution-version-required' }))
  policy.check('plugin', member, 'shared', '1.0.1'); policy.check('plugin', member, 'shared', '1.0.1')
  expect(comparePluginVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1)
  expect(comparePluginVersions('1.0.0-a-b', '1.0.0-a-c')).toBe(-1)
  expect(comparePluginVersions('999999999999999999999.0.0', '999999999999999999998.0.0')).toBe(1)
})
it('shows added, modified and deleted skill files and declaration changes against the actual previous artifact', async () => {
  const policy = new ContributionPolicy({ list: () => [{ name: 'shared', description: 'Skill', hash: 'old', importedAt: 0, published: false }] }, { list: () => [] }, { read: async () => ({ markdown: '', files: ['SKILL.md', 'old.py'], fileHashes: { 'SKILL.md': 'old', 'old.py': 'removed' } }) })
  const { plugin, ...skill } = contribution; void plugin
  const result = await policy.review({ ...skill, kind: 'skill', fileHashes: { 'SKILL.md': 'new', 'new.py': 'added' } })
  expect(result).toMatchObject({ maintainer: null, canAssignMaintainer: true, changes: { added: ['new.py'], changed: ['SKILL.md'], deleted: ['old.py'], declaration: { after: contribution.declaration } } })
})
it('commits provenance with the selected contribution version and keeps it when an administrator changes the version', async () => {
  let rows: LibraryPlugin[] = []
  const library = new PluginLibrary({ get: name => name === actor.username ? actor : member }, { list: () => rows, save: row => { rows = [...rows.filter(old => old.packageName !== row.packageName), row] }, remove: () => {} }, { prepare: async input => ({ ...prepared, version: input.version, integrity: 'next' }) }, undefined, { impact: () => ({ groups: 0, members: 0 }), revoke: () => {} })
  library.adoptContribution(actor, prepared, prepared, 'new', { id: contribution.id, revision: contribution.revision, adoption: { row: contribution } }, () => {})
  expect(rows[0]?.provenance?.maintainer).toEqual({ username: member.username, spaceId: member.spaceId })
  library.replace(actor, { packageName: prepared.packageName, version: '1.0.1' }); await library.drain()
  library.select(actor, prepared.packageName, library.impact(actor, prepared.packageName).revision)
  expect(rows[0]?.provenance?.maintainer?.username).toBe('member')
  expect(rows[0]?.provenance?.versions.map(row => row.source)).toEqual(['member', 'administrator'])
})
