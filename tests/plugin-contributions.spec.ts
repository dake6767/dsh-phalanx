import { PluginCompatibility } from '../src/use-cases/plugin-compatibility.js'
import { PluginMarket } from '../src/use-cases/plugin-market.js'
import { memoryContributions, fakeContributionLibrary } from './fixtures/contributions.js'
import { MemberContributions } from '../src/use-cases/member-contributions.js'
import { expect, it } from 'vitest'
import { PluginContributions } from '../src/use-cases/plugin-contributions.js'
import { PluginLibrary } from '../src/use-cases/plugin-library.js'
import type { LibraryPlugin, PreparedPlugin } from '../src/domain/plugin-library.js'
import type { MemberContribution } from '../src/domain/member-contribution.js'

it('prechecks npm and uploaded contributions privately and only selects the approved independent copy after fresh impact confirmation', async () => {
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }, rows: LibraryPlugin[] = []
  const prepared: PreparedPlugin = { packageName: 'team-plugin', version: '1.0.0', integrity: 'sha512-original', artifact: 'artifacts/private', preparationId: 'prepared', runtimeRevision: 'runtime', title: 'Team plugin', description: 'Team tool', bundlePatch: '- id: team\n  name: ./index.js', dependencies: {} }
  const library = new PluginLibrary({ get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }) }, { list: () => rows, save: row => { const index = rows.findIndex(old => old.packageName === row.packageName); if (index >= 0) rows[index] = row; else rows.push(row) }, remove: () => {} }, { prepare: async () => prepared }, undefined, { impact: () => ({ groups: 0, members: 0 }), revoke: () => {} }, 'current/runtime')
  const sources: string[] = [], promoted: string[] = []
  const service = new PluginContributions({ prepare: async input => { sources.push(input.source); return { name: prepared.packageName, description: prepared.description, hash: 'fingerprint', markdown: '', files: ['package.json', 'cordis.patch.yml'], keyFiles: [{ path: 'package.json', content: '{}' }], plugin: { candidate: { packageName: prepared.packageName, version: prepared.version }, prepared } } }, publish: async (artifact, commit) => { promoted.push(artifact.prepared.packageName); commit({ ...artifact, checkedFor: 'current/runtime', prepared: { ...artifact.prepared, artifact: 'artifacts/platform-copy' } }, () => {}) }, recover: async () => {} }, library)
  expect(() => service.accept({ source: 'npm', packageName: 'team-plugin', version: 'latest' }, new AbortController().signal)).toThrow(expect.objectContaining({ code: 'plugin-identity-invalid' }))
  const upload = await service.accept({ source: 'npm', packageName: 'team-plugin', version: '1.0.0' }, new AbortController().signal)
  expect(library.list(actor)).toEqual([])
  async function* bytes() { yield new Uint8Array([1]) }
  await service.accept({ source: 'upload', filename: 'team.tgz', content: bytes() }, new AbortController().signal)
  expect(sources).toEqual(['npm', 'upload'])
  const row: MemberContribution = { ...upload, kind: 'plugin', id: 'id', revision: 'revision', contributor: actor, declaration: { purpose: 'Team tool' }, submittedAt: 0, updatedAt: 0, status: 'pending' }
  expect(() => library.adoptContribution(actor, { packageName: prepared.packageName, version: prepared.version }, prepared, 'new', { id: 'id', revision: 'revision', checkedFor: 'old/runtime' }, () => {})).toThrow('plugin-incompatible')
  const review = service.review(actor, row, 'review-token')
  let committed = false
  await service.confirm(actor, row, review, () => { committed = true })
  expect(committed).toBe(true); expect(promoted).toEqual(['team-plugin'])
  expect(library.list(actor)[0]).toMatchObject({ packageName: 'team-plugin', stage: 'available', published: false })
  expect(service.adopted(row)).toBe(true)
})


it('keeps plugin paths private, isolates same-name skill records and recovers a committed plugin after a status-write failure', async () => {
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
  const store = memoryContributions(), library = fakeContributionLibrary()
  let id = 0, adopted = false
  const artifact = { candidate: { packageName: 'same-name', version: '1.0.0' }, prepared: { packageName: 'same-name', version: '1.0.0', integrity: 'sha512-original', artifact: '/private/path', runtimeRevision: 'runtime', title: 'Name', description: '', bundlePatch: '', dependencies: {} } }
  const plugins = { accept: async () => ({ name: 'same-name', description: '', markdown: '', files: ['package.json'], hash: 'plugin-hash', plugin: artifact, keyFiles: [] }), review: (_actor: unknown, _row: unknown, token: string) => ({ name: 'same-name', description: '', markdown: '', files: ['package.json'], token, revision: 'new', replacing: false, managedMembers: 0, selectedMembers: 0 }), confirm: async (_actor: unknown, _row: unknown, _preview: unknown, committed: () => void) => { adopted = true; committed() }, adopted: () => adopted, collect: async () => {} }
  const artifacts = { accept: async () => ({ name: 'same-name', description: '', markdown: '', files: ['SKILL.md'], hash: 'skill-hash' }), read: async () => new Uint8Array(), collect: async () => {}, newId: () => String(++id) }
  const accounts = { get: () => ({ ...actor, admin: true, disabled: false, email: '', groupId: 'admins', createdAt: 0, updatedAt: 0 }) }
  const service = new MemberContributions(accounts, store, artifacts, library, { now: () => 1 }, undefined, undefined, plugins)
  async function* bytes() { yield new Uint8Array([1]) }
  const skill = await service.submit(actor, { purpose: 'Share skill' }, bytes(), new AbortController().signal)
  const plugin = await service.submitPlugin(actor, { purpose: 'Share plugin' }, { source: 'npm', packageName: 'same-name', version: '1.0.0' }, new AbortController().signal)
  expect(plugin.plugin).toBeUndefined(); expect(service.list(actor).every(row => !row.plugin)).toBe(true)
  expect(plugin.id).not.toBe(skill.id); expect(store.list().find(row => row.id === plugin.id)?.plugin).toEqual(artifact)
  const preview = await service.review(actor, plugin.id, plugin.revision)
  const finish = store.finish; store.finish = () => { throw new Error('disk unavailable') }
  await expect(service.decide(actor, plugin.id, { action: 'adopt', revision: plugin.revision, token: preview.token })).rejects.toThrow('disk unavailable')
  store.finish = finish
  await service.recover()
  expect(service.list(actor).find(row => row.id === plugin.id)?.status).toBe('adopted')
  expect(service.list(actor).find(row => row.id === skill.id)?.status).toBe('pending')
})

it('redacts contributed metadata in the library and market after a compatibility rebuild reads the immutable original', async () => {
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0, admin: true, disabled: false, email: '', groupId: 'admins', createdAt: 0, updatedAt: 0 }
  const original = { packageName: 'contributed', version: '1.0.0', integrity: 'pinned', artifact: 'artifacts/original', runtimeRevision: 'old', title: 'apiKey = "personal-key"', description: 'apiKey = "personal-key"', bundlePatch: '[]', dependencies: {} }
  let row: LibraryPlugin = { packageName: original.packageName, version: original.version, current: { ...original, title: 'Safe', description: 'Safe' }, stage: 'available', published: true, contributionReceipt: { id: 'id', revision: 'revision' } }
  const store = { list: () => [row], save: (value: LibraryPlugin) => { row = value }, remove: () => {} }, preparer = { prepare: async () => ({ ...original, runtimeRevision: 'new' }) }, accounts = { get: () => actor, list: () => [actor] }
  await new PluginCompatibility(store, preparer, 'next/new').recover()
  expect(row.current?.description).toContain('personal-key')
  const library = new PluginLibrary(accounts, store, preparer)
  expect(JSON.stringify(library.list(actor))).not.toContain('personal-key')
  const market = new PluginMarket(accounts, store, { list: async () => [] }, { ensure: async () => ({ userId: actor.username, origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1, managedSnapshot: [] }) }, { get: () => [], set: () => {}, members: () => [], removePackage: () => {}, retainPackages: () => {} }, { granted: () => [], effective: () => [] }, 'new')
  expect(JSON.stringify(await market.list(actor, new URL('http://localhost'), new AbortController().signal))).not.toContain('personal-key')
})

it('round-trips declared environment references through the public adoption draft while hiding credential literals', async () => {
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
  const accounts = { get: () => ({ ...actor, admin: true, disabled: false, email: '', groupId: 'admins', createdAt: 0, updatedAt: 0 }) }
  const artifact = { candidate: { packageName: 'search', version: '1.0.0' }, prepared: { packageName: 'search', version: '1.0.0', integrity: 'pinned', artifact: 'artifacts/search', runtimeRevision: 'runtime', title: 'Search', description: '', bundlePatch: '', dependencies: {} } }
  const access = { environment: [{ name: 'ANYSEARCH_API_KEY', value: '{access-token}' }], entriesYaml: JSON.stringify({ search: { apiKeyEnv: 'ANYSEARCH_API_KEY', apiKey: 'personal-key', secret: true, token: false, password: null } }) }
  let adopted = false, captured: import('../src/domain/member-contribution.js').ContributionSetup | undefined, id = 0
  const plugins = {
    accept: async () => ({ name: 'search', description: '', markdown: '', files: ['package.json'], hash: 'hash', plugin: artifact, keyFiles: [] }),
    review: (_actor: unknown, _row: unknown, token: string) => ({ name: 'search', description: '', markdown: '', files: ['package.json'], token, revision: 'revision', replacing: false, managedMembers: 0, selectedMembers: 0, plugin: { access, upstreams: [], removed: { environment: [], entries: [], upstreams: [] } } }),
    confirm: async (_actor: unknown, _row: unknown, _review: unknown, committed: () => void, setup?: import('../src/domain/member-contribution.js').ContributionSetup) => { captured = setup; adopted = true; committed() },
    adopted: () => adopted, collect: async () => {},
  }
  const artifacts = { accept: async () => ({ name: 'skill', description: '', markdown: '', files: [], hash: 'skill' }), read: async () => new Uint8Array(), collect: async () => {}, newId: () => String(++id) }
  const service = new MemberContributions(accounts, memoryContributions(), artifacts, fakeContributionLibrary(), { now: () => 0 }, undefined, undefined, plugins)
  const declaration = { purpose: 'Search', plugin: { upstreams: [], environment: [{ name: 'ANYSEARCH_API_KEY', secret: true, purpose: 'Authenticate', application: 'Dashboard' }], entriesYaml: JSON.stringify({ search: { apiKeyEnv: 'ANYSEARCH_API_KEY' } }) } }
  const row = await service.submitPlugin(actor, declaration, { source: 'npm', packageName: 'search', version: '1.0.0' }, new AbortController().signal, true)
  const review = await service.review(actor, row.id, row.revision)
  expect(JSON.parse(review.plugin!.access.entriesYaml).search).toEqual({ apiKeyEnv: 'ANYSEARCH_API_KEY', apiKey: '[redacted]', secret: true, token: false, password: null })
  await service.decide(actor, row.id, { action: 'adopt', revision: row.revision, token: review.token, setup: { plugin: { access: review.plugin!.access, upstreams: review.plugin!.upstreams } } })
  expect(JSON.parse(captured!.plugin!.access.entriesYaml).search.apiKeyEnv).toBe('ANYSEARCH_API_KEY')
})
