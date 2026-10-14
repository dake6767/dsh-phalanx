import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PluginContributionAdministration } from '../src/use-cases/plugin-contribution-administration.js'
import { PluginAccessAdministration } from '../src/use-cases/plugin-access-administration.js'
import { PluginUpstreamAdministration } from '../src/use-cases/plugin-upstream-administration.js'
import { FilePluginAccessStore } from '../src/adapters/plugin-access-store.js'
import { FilePluginUpstreams } from '../src/adapters/plugin-upstreams.js'
import { YamlPluginAccessSyntax } from '../src/adapters/plugin-access-syntax.js'
import type { MemberContribution } from '../src/domain/member-contribution.js'
import type { LibraryPlugin, PreparedPlugin } from '../src/domain/plugin-library.js'

it('previews privately, applies administrator credentials only after adoption and preserves later edits during replay and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-contribution-adoption-'))
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0, admin: true, disabled: false, email: '', groupId: 'admins', createdAt: 0, updatedAt: 0 }
  const accounts = { get: () => actor }, rows: LibraryPlugin[] = []
  const prepared: PreparedPlugin = { packageName: 'team-search', version: '1.0.0', integrity: 'pinned', artifact: 'artifacts/private', runtimeRevision: 'runtime', title: 'Search', description: '', dependencies: {}, bundlePatch: '[{"insert":[{"id":"search","name":"team-search"}]}]' }
  const row: MemberContribution = { kind: 'plugin', id: 'contribution', revision: 'revision', name: 'team-search', description: '', hash: 'fingerprint', markdown: '', files: [], contributor: actor, submittedAt: 1, updatedAt: 1, status: 'pending', plugin: { candidate: { packageName: 'team-search', version: '1.0.0' }, prepared }, declaration: { purpose: 'Share search', plugin: { upstreams: [{ name: 'search', baseUrl: 'https://provider.example', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }] }], environment: [{ name: 'SEARCH_KEY', secret: true, purpose: 'Authenticate', application: 'Provider dashboard' }], entriesYaml: 'search:\n  baseURL: "{upstream:search}"' } } }
  try {
    await mkdir(root, { recursive: true })
    const accessPath = join(root, 'access.json'), upstreamPath = join(root, 'upstreams.json'), library = { list: () => rows }
    let access = new FilePluginAccessStore(accessPath), upstreams = new FilePluginUpstreams(upstreamPath)
    let accessAdmin = new PluginAccessAdministration(accounts, library, access, upstreams, new YamlPluginAccessSyntax()), upstreamAdmin = new PluginUpstreamAdministration(accounts, library, upstreams, accessAdmin)
    const makeService = () => new PluginContributionAdministration(accessAdmin, upstreamAdmin, new YamlPluginAccessSyntax())
    let service = makeService()
    const preview = service.preview(actor, row)
    expect(preview.plugin.upstreams[0]).toMatchObject({ name: 'search', hasCredential: false })
    expect(preview.plugin.access.environment).toEqual([{ name: 'SEARCH_KEY', value: '{access-token}' }])
    expect(access.list()).toEqual({}); expect(upstreams.list(row.name)).toEqual([])
    const setup = { plugin: { access: preview.plugin.access, upstreams: [{ ...preview.plugin.upstreams[0]!, credential: 'initial-platform-fixture-secret' }] } }
    service.validate(actor, row, setup)
    rows.push({ ...row.plugin!.candidate, stage: 'available', current: prepared, published: false })
    await service.apply(row, setup)
    expect(upstreams.list(row.name)[0]?.credential).toBe('initial-platform-fixture-secret')
    upstreamAdmin.execute(actor, row.name, { action: 'save', upstream: { ...setup.plugin.upstreams[0]!, credential: 'later-platform-fixture-secret' } })
    accessAdmin.save(actor, row.name, { ...setup.plugin.access, environment: [{ name: 'SEARCH_KEY', value: '{access-token}' }, { name: 'LATER', value: 'administrator edit' }] })
    access = new FilePluginAccessStore(accessPath); upstreams = new FilePluginUpstreams(upstreamPath)
    accessAdmin = new PluginAccessAdministration(accounts, library, access, upstreams, new YamlPluginAccessSyntax()); upstreamAdmin = new PluginUpstreamAdministration(accounts, library, upstreams, accessAdmin); service = makeService()
    await service.apply(row, setup)
    expect(upstreams.list(row.name)[0]?.credential).toBe('later-platform-fixture-secret')
    expect(access.get(row.name)?.environment).toContainEqual({ name: 'LATER', value: 'administrator edit' })
    expect(JSON.stringify(service.preview(actor, row))).not.toContain('later-platform-fixture-secret')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('completes a confirmed adoption with a durable warning when another administrator occupies a declared variable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-contribution-race-'))
  try {
    const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0, admin: true, disabled: false, email: '', groupId: 'admins', createdAt: 0, updatedAt: 0 }
    const accounts = { get: () => actor }, prepared: PreparedPlugin = { packageName: 'new-plugin', version: '1.0.0', integrity: 'pinned', artifact: 'private', runtimeRevision: 'runtime', title: '', description: '', dependencies: {}, bundlePatch: '[{"insert":[{"id":"entry","name":"new-plugin"}]}]'  }
    const rows: LibraryPlugin[] = [{ ...prepared, packageName: 'other', current: { ...prepared, packageName: 'other' }, stage: 'available', published: false }]
    const library = { list: () => rows }, syntax = new YamlPluginAccessSyntax(), upstreams = new FilePluginUpstreams(join(root, 'upstreams.json'))
    let access = new FilePluginAccessStore(join(root, 'access.json'))
    let owner = new PluginAccessAdministration(accounts, library, access, upstreams, syntax)
    const input = { environment: [{ name: 'SHARED_NAME', value: 'candidate' }], entriesYaml: '' }, receipt = { id: 'contribution', revision: 'revision' }
    owner.validateContribution(actor, prepared, input, [])
    // The promotion seam yields; a different administrator saves a valid competing configuration.
    owner.save(actor, 'other', { environment: [{ name: 'SHARED_NAME', value: 'administrator' }], entriesYaml: '' })
    rows.push({ ...prepared, current: prepared, stage: 'available', published: false })
    const warnings = owner.adoptContribution(prepared, input, receipt)
    expect(warnings).toHaveLength(1); expect(access.get('new-plugin')).toBeUndefined()
    expect(access.get('other')?.environment[0]?.value).toBe('administrator')
    access = new FilePluginAccessStore(join(root, 'access.json')); owner = new PluginAccessAdministration(accounts, library, access, upstreams, syntax)
    expect(owner.adoptContribution(prepared, input, receipt)).toEqual(warnings)
    expect(access.get('new-plugin')).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})
