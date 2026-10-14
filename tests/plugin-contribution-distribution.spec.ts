import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilePluginGrants } from '../src/adapters/plugin-grants.js'
import { expect, it } from 'vitest'
import { PluginContributionDistribution } from '../src/use-cases/plugin-contribution-distribution.js'
import { ManagedPluginAdministration } from '../src/use-cases/managed-plugin-administration.js'
import { PluginMarket } from '../src/use-cases/plugin-market.js'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'
import type { MemberContribution } from '../src/domain/member-contribution.js'
it('checks group impact before adoption and replays publication and grants once while preserving later administrator choices', () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0, admin: true, disabled: false, email: '', groupId: 'admin', createdAt: 0, updatedAt: 0 }
  let groups = [{ id: 'ordinary', name: 'Team', kind: 'ordinary' as const, isDefault: true, memberCount: 0 }], granted: readonly string[] = []
  const accounts = { get: () => actor, list: () => [actor], listGroups: () => groups }
  const prepared = { packageName: 'plugin', version: '1.0.0', integrity: 'pinned', artifact: 'artifact', runtimeRevision: 'runtime', title: 'Plugin', description: '', bundlePatch: '[]', dependencies: {} }
  let plugin: LibraryPlugin = { ...prepared, current: prepared, stage: 'available', published: false }
  const library = { list: () => [plugin], save: (row: LibraryPlugin) => { plugin = row }, remove: () => {} }
  const managed = new ManagedPluginAdministration(accounts, library, { get: () => granted, set: (_id, next) => { granted = next }, remove: () => {}, retainGroups: () => {} }, { effective: () => [] }, { status: () => ({ state: 'stopped' }) }, { restart: async () => ({ userId: 'admin', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1 }) }, 'runtime')
  const market = new PluginMarket(accounts, library, { list: async () => [] }, { ensure: async () => ({ userId: 'admin', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1 }) }, { get: () => [], set: () => {}, members: () => [], removePackage: () => {}, retainPackages: () => {} }, { effective: () => [], granted: () => [] }, 'runtime')
  const service = new PluginContributionDistribution(library, managed, market)
  const row: MemberContribution = { kind: 'plugin', id: 'contribution', revision: 'revision', name: 'plugin', description: '', hash: 'fingerprint', markdown: '', files: [], contributor: actor, submittedAt: 1, updatedAt: 1, status: 'pending', plugin: { candidate: { packageName: 'plugin', version: '1.0.0' }, prepared }, declaration: { purpose: 'Share plugin' } }
  const view = service.groups(actor, row.name), setup = { published: true, credentialSharingConfirmed: true, groups: view.map(group => ({ id: group.group.id, revision: group.revision })) }
  service.validate(actor, row.name, setup)
  granted = ['other']; expect(() => service.validate(actor, row.name, setup)).toThrow(expect.objectContaining({ code: 'plugin-impact-changed' }))
  granted = []; expect(service.apply(row, setup)).toEqual([]); expect(granted).toEqual(['plugin']); expect(plugin.published).toBe(true)
  granted = []; plugin = { ...plugin, published: false }
  expect(service.apply(row, setup)).toEqual([]); expect(granted).toEqual([]); expect(plugin.published).toBe(false)
  groups = []; expect(service.apply({ ...row, id: 'another', revision: 'next' }, setup)).toEqual(['A selected group was removed; its plugin grant was not applied.'])
})

it('preserves later revoke and unpublish if final orchestration receipt fails after both effects were committed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-distribution-'))
  try {
    const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0, admin: true, disabled: false, email: '', groupId: 'admins', createdAt: 0, updatedAt: 0 }
    const groups = [{ id: 'team', name: 'Team', kind: 'ordinary' as const, isDefault: true, memberCount: 0 }]
    const accounts = { get: () => actor, list: () => [actor], listGroups: () => groups }
    const prepared = { packageName: 'plugin', version: '1.0.0', integrity: 'pinned', artifact: 'artifact', runtimeRevision: 'runtime', title: '', description: '', bundlePatch: '[]', dependencies: {} }
    let plugin: LibraryPlugin = { ...prepared, current: prepared, stage: 'available', published: false }, fail = true
    const library = { list: () => [plugin], save: (row: LibraryPlugin) => { if (row.contributionDistributionReceipt && fail) { fail = false; throw Error('interrupted final receipt') }; plugin = structuredClone(row) }, remove: () => {} }
    let grants = new FilePluginGrants(join(root, 'grants.json'))
    const managed = () => new ManagedPluginAdministration(accounts, library, grants, { effective: () => [] }, { status: () => ({ state: 'stopped' }) }, { restart: async () => ({ userId: 'admin', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1 }) }, 'runtime')
    const market = new PluginMarket(accounts, library, { list: async () => [] }, { ensure: async () => ({ userId: 'admin', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1 }) }, { get: () => [], set: () => {}, members: () => [], removePackage: () => {}, retainPackages: () => {} }, { effective: () => [], granted: () => [] }, 'runtime')
    const row: MemberContribution = { kind: 'plugin', id: 'id', revision: 'revision', name: 'plugin', description: '', hash: 'fingerprint', markdown: '', files: [], contributor: actor, submittedAt: 1, updatedAt: 1, status: 'pending', plugin: { candidate: prepared, prepared }, declaration: { purpose: 'Share' } }
    const setup = { published: true, credentialSharingConfirmed: true, groups: [{ id: 'team', revision: 'review' }] }
    expect(() => new PluginContributionDistribution(library, managed(), market).apply(row, setup)).toThrow('interrupted final receipt')
    expect(grants.get('team')).toEqual(['plugin']); expect(plugin.published).toBe(true)
    grants.set('team', []); market.publish(actor, 'plugin', false, { confirmed: true, selectedMembers: 0 })
    grants = new FilePluginGrants(join(root, 'grants.json'))
    expect(new PluginContributionDistribution(library, managed(), market).apply(row, setup)).toEqual([])
    expect(grants.get('team')).toEqual([]); expect(plugin.published).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('finishes with a durable sharing warning if credentials appear after confirmation, and does not publish on replay', () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0, admin: true, disabled: false, email: '', groupId: 'admin', createdAt: 0, updatedAt: 0 }
  const accounts = { get: () => actor, list: () => [actor] }
  const prepared = { packageName: 'plugin', version: '1.0.0', integrity: 'pinned', artifact: 'artifact', runtimeRevision: 'runtime', title: '', description: '', bundlePatch: '[]', dependencies: {} }
  let plugin: LibraryPlugin = { ...prepared, current: prepared, stage: 'available', published: false }
  const library = { list: () => [plugin], save: (row: LibraryPlugin) => { plugin = structuredClone(row) }, remove: () => {} }
  let credential = ''
  const market = new PluginMarket(accounts, library, { list: async () => [] }, { ensure: async () => ({ userId: 'admin', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1 }) }, { get: () => [], set: () => {}, members: () => [], removePackage: () => {}, retainPackages: () => {} }, { effective: () => [], granted: () => [] }, 'runtime', undefined, { list: () => [{ name: 'search', baseUrl: 'https://provider.example', headers: [], credential }] })
  // Confirmation was valid without sharing when promotion yielded. Another administrator adds a credential.
  credential = 'new-platform-fixture-secret'
  const receipt = { id: 'contribution', revision: 'revision' }, warnings = market.publishContribution('plugin', false, receipt)
  expect(warnings).toHaveLength(1); expect(plugin.published).toBe(false)
  credential = ''
  expect(market.publishContribution('plugin', false, receipt)).toEqual(warnings); expect(plugin.published).toBe(false)
})
